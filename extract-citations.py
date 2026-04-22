#!/usr/bin/env python3
"""
extract-citations.py — deterministic citation-graph extractor for the
SOA-Harness reference-implementation repo.

Mirrors the spec-repo extractor's shape but adapts to the impl-repo's
document topology:

  - No normative Core/UI spec markdown lives here (that's the spec repo).
    Every § reference found in impl docs points at a sibling-spec section
    node; the node is flagged `spec_*` and treated as an "external"
    reference target that the spec-repo graph owns.
  - Test IDs (SV-*, HR-*, UV-*) appear in STATUS.md, plans, and code
    comments; extraction surface = every tracked .md file.
  - Cross-repo file references ("soa-harness-specification/...",
    "soa-validate/...") become edges to file_<repo>_<path> nodes so
    cross-repo coordination queries light up.

Scope: ingests only documents (README/CLAUDE/CONTRIBUTING/STATUS/
docs/**/*.md/packages/*/README.md/packages/*/docs/**/*.md/
docs/plans/*.md). Code files are intentionally skipped — CodeGraphContext
already indexes them.

Produces JSON in graphify extraction schema.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

HEADING_RE = re.compile(r'^(#{1,6})\s+(.+?)\s*$', re.M)
XREF_RE = re.compile(r'(Core|UI)\s*(?:Spec(?:ification)?|Profile)?\s*§\s*(\d+(?:\.\d+)*)', re.I)
# Bare § refs with no Core/UI prefix — impl docs use these extensively
# ("§10.3 step 3", "§14.1.1 CrashEvent payload"). Since this repo has no
# local spec headings, every bare § is classified as a Core-spec reference
# unless a sibling heading explicitly says otherwise.
INTRADOC_RE = re.compile(r'(?<![A-Za-z])§\s*(\d+(?:\.\d+)*)')
TESTID_RE = re.compile(r'\b(UV|SV|HR)-([A-Z0-9]+)?-?(\d+)(?:\.\.(\d+))?([a-z])?\b')
# Match either SV-CARD-10, HR-14, or HR-02/03/06 (slash-delimited ranges)
HR_RE = re.compile(r'\bHR-(\d+)(?:/(\d+))*(?:\.\.(\d+))?\b')
SV_RE = re.compile(r'\bSV-([A-Z]+(?:-[A-Z]+)*)-(\d+)(?:\.\.(\d+))?([a-z])?\b')
UV_RE = re.compile(r'\bUV-([A-Z]+(?:-[A-Z]+)*)-(\d+)(?:\.\.(\d+))?\b')

# Cross-repo file references: match things like "soa-harness-specification/foo/bar.md"
# or relative paths "../soa-validate/something". Extensions kept broad — .md/.json/.ts/.go.
CROSSREPO_RE = re.compile(
    r'(?:\.\./)?(soa-harness(?:[-=]specification)?|soa-validate)/'
    r'([\w\-./]+(?:\.md|\.json|\.ts|\.go|\.py|\.yaml|\.yml|\.jws|\.pem))'
)

# Files we DO ingest (relative to repo root, glob form).
INGEST_GLOBS = [
    "README.md",
    "CONTRIBUTING.md",
    "CLAUDE.md",
    "STATUS.md",
    "COORDINATION.md",
    "docs/**/*.md",
    "docs/plans/*.md",
    "packages/*/README.md",
    "packages/*/docs/**/*.md",
    "tools/*/README.md",
]

# Paths we NEVER ingest even if they match a glob.
EXCLUDE_PREFIXES = (
    "node_modules/",
    "dist/",
    "build/",
    ".git/",
    ".claude/",
    "graphify-out/",
    "coverage/",
    "__pycache__/",
)


def make_node(nid, label, src, location=None, file_type='document'):
    return {
        'id': nid,
        'label': label,
        'file_type': file_type,
        'source_file': src,
        'source_location': location,
        'source_url': None,
        'captured_at': None,
        'author': None,
        'contributor': None,
    }


def make_edge(src, tgt, relation, src_file=None, location=None, score=1.0):
    return {
        'source': src,
        'target': tgt,
        'relation': relation,
        'confidence': 'EXTRACTED',
        'confidence_score': score,
        'source_file': src_file,
        'source_location': location,
        'weight': 1.0,
    }


def parse_headings(text):
    """Capture every Markdown heading with its offset + lineno."""
    out = []
    for m in HEADING_RE.finditer(text):
        title = m.group(2).strip()
        lineno = text[:m.start()].count('\n') + 1
        out.append((m.start(), title, lineno))
    return out


def containing_heading(pos, headings):
    current = None
    for off, title, _ in headings:
        if off <= pos:
            current = title
        else:
            break
    return current


def collect_ingest_paths(root: Path) -> list[Path]:
    seen = set()
    paths = []
    for pat in INGEST_GLOBS:
        for p in root.glob(pat):
            if not p.is_file():
                continue
            rel = str(p.relative_to(root)).replace('\\', '/')
            if any(rel.startswith(x) for x in EXCLUDE_PREFIXES):
                continue
            if rel in seen:
                continue
            seen.add(rel)
            paths.append(p)
    return sorted(paths)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root', nargs='?', default='.')
    ap.add_argument('--audit', action='store_true', help='print integrity audit to stderr')
    ap.add_argument('-o', '--output', default='graphify-out/citations.json')
    args = ap.parse_args()

    root = Path(args.root).resolve()
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    md_files = collect_ingest_paths(root)

    ingested_rel_paths: list[str] = []

    for md in md_files:
        rel = str(md.relative_to(root)).replace('\\', '/')
        ingested_rel_paths.append(rel)
        try:
            text = md.read_text(encoding='utf-8')
        except OSError:
            continue
        headings = parse_headings(text)

        file_nid = f'file_{rel.replace("/", "_").replace(".", "_").replace(" ", "_").replace("-", "_")}'
        if file_nid not in nodes:
            nodes[file_nid] = make_node(file_nid, rel, rel, file_type='document')

        # Cross-doc refs: "Core §10.3" or "UI §14.5".
        for m in XREF_RE.finditer(text):
            which = m.group(1).lower()
            num = m.group(2)
            target_prefix = 'core' if which == 'core' else 'ui'
            tgt = f'spec_{target_prefix}_section_{num.replace(".", "_")}'
            if tgt not in nodes:
                nodes[tgt] = make_node(
                    tgt,
                    f'{m.group(1)} §{num} (spec repo)',
                    '<sibling: soa-harness-specification>',
                    file_type='document',
                )
            lineno = text[:m.start()].count('\n') + 1
            edges.append(make_edge(file_nid, tgt, 'cites', rel, f'line {lineno}'))

        # Bare intra-doc § refs — assume Core unless text disambiguates.
        cross_spans = [(m.start(), m.end()) for m in XREF_RE.finditer(text)]
        def is_in_cross(pos, spans=cross_spans):
            return any(s <= pos < e for s, e in spans)

        for m in INTRADOC_RE.finditer(text):
            if is_in_cross(m.start()):
                continue
            num = m.group(1)
            tgt = f'spec_core_section_{num.replace(".", "_")}'
            if tgt not in nodes:
                nodes[tgt] = make_node(
                    tgt,
                    f'Core §{num} (spec repo)',
                    '<sibling: soa-harness-specification>',
                    file_type='document',
                )
            lineno = text[:m.start()].count('\n') + 1
            edges.append(make_edge(file_nid, tgt, 'cites', rel, f'line {lineno}'))

        # Test IDs — SV-<CAT>-<N>[a] plus ranges like SV-PERM-01..08
        for m in SV_RE.finditer(text):
            cat, num, range_end, letter = m.groups()
            base = int(num)
            end = int(range_end) if range_end else base
            for i in range(base, end + 1):
                suffix = (letter or '') if (i == base and not range_end) else ''
                tid = f'SV-{cat}-{i}{suffix}'
                tid_nid = f'test_{tid.lower().replace("-", "_")}'
                if tid_nid not in nodes:
                    nodes[tid_nid] = make_node(tid_nid, tid, rel, file_type='document')
                lineno = text[:m.start()].count('\n') + 1
                edges.append(make_edge(file_nid, tid_nid, 'validated_by', rel, f'line {lineno}'))

        # HR-<N> alone OR HR-02/03/06 (slash-delimited lists) OR HR-01..04 (ranges)
        for m in HR_RE.finditer(text):
            chunk = m.group(0)
            # Find every decimal number in the chunk
            numbers = [int(n) for n in re.findall(r'\d+', chunk)]
            if '..' in chunk and len(numbers) >= 2:
                numbers = list(range(numbers[0], numbers[-1] + 1))
            for n in numbers:
                tid = f'HR-{n:02d}'
                tid_nid = f'test_{tid.lower().replace("-", "_")}'
                if tid_nid not in nodes:
                    nodes[tid_nid] = make_node(tid_nid, tid, rel, file_type='document')
                lineno = text[:m.start()].count('\n') + 1
                edges.append(make_edge(file_nid, tid_nid, 'validated_by', rel, f'line {lineno}'))

        for m in UV_RE.finditer(text):
            cat, num, range_end = m.groups()
            base = int(num)
            end = int(range_end) if range_end else base
            for i in range(base, end + 1):
                tid = f'UV-{cat}-{i}'
                tid_nid = f'test_{tid.lower().replace("-", "_")}'
                if tid_nid not in nodes:
                    nodes[tid_nid] = make_node(tid_nid, tid, rel, file_type='document')
                lineno = text[:m.start()].count('\n') + 1
                edges.append(make_edge(file_nid, tid_nid, 'validated_by', rel, f'line {lineno}'))

        # Cross-repo file references — "soa-harness-specification/foo" or "soa-validate/bar"
        for m in CROSSREPO_RE.finditer(text):
            repo, path = m.group(1), m.group(2)
            repo_norm = repo.replace('=', '-').replace('-specification', '-spec')
            target_rel = f'{repo_norm}/{path}'
            tgt = f'file_crossrepo_{target_rel.replace("/", "_").replace(".", "_").replace("-", "_")}'
            if tgt not in nodes:
                nodes[tgt] = make_node(
                    tgt,
                    target_rel,
                    f'<sibling: {repo}>',
                    file_type='document',
                )
            lineno = text[:m.start()].count('\n') + 1
            edges.append(make_edge(file_nid, tgt, 'references_sibling', rel, f'line {lineno}'))

        # Heading-to-heading + heading-to-file structural edges: connect each
        # heading inside this file to the file node so queries can find
        # "which docs have an H2 about X" without LLM inference.
        for _off, title, lineno in headings:
            heading_nid = (
                f'heading_{file_nid}_{re.sub(r"[^a-z0-9]+", "_", title.lower())[:60]}'
            )
            if heading_nid not in nodes:
                nodes[heading_nid] = make_node(
                    heading_nid,
                    title,
                    rel,
                    f'line {lineno}',
                    file_type='document',
                )
            edges.append(make_edge(file_nid, heading_nid, 'contains', rel, f'line {lineno}'))

    out = {
        'nodes': list(nodes.values()),
        'edges': edges,
        'hyperedges': [],
        'input_tokens': 0,
        'output_tokens': 0,
    }
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2), encoding='utf-8')
    print(f'Wrote {len(out["nodes"])} nodes, {len(out["edges"])} edges to {args.output}')
    print(f'Ingested {len(ingested_rel_paths)} markdown file(s)')

    if args.audit:
        print('', file=sys.stderr)
        print('=== Integrity audit ===', file=sys.stderr)
        for rel in ingested_rel_paths[:40]:
            print(f'  ingested: {rel}', file=sys.stderr)


if __name__ == '__main__':
    main()
