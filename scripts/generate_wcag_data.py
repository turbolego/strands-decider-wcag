#!/usr/bin/env python3
"""
Full WCAG 2.2 training data pipeline:
  1. Fetch a URL via Playwright (renders full DOM)
  2. Run axe-core via axe-playwright-python (ground truth)
  3. Chunk the DOM into semantic, auditable states
  4. Convert to Strands Decider JSONL format

Usage:
    python scripts/generate_wcag_data.py --url https://example.com --output data/wcag/train.jsonl [--max-tokens 3000] [--test-split 0.2]
"""

import argparse
import json
import random
import sys
import warnings
from collections import defaultdict
from pathlib import Path

from bs4 import BeautifulSoup, Comment, NavigableString
from playwright.sync_api import sync_playwright
from axe_playwright_python.sync_playwright import Axe

warnings.filterwarnings("ignore")


# ── Mapping ────────────────────────────────────────────────────────────────

RULE_QUESTIONS = {
    "image-alt":             "Does this HTML snippet provide alternative text for all images?",
    "button-name":           "Do all buttons in this snippet have discernible text?",
    "label":                 "Are all form inputs in this snippet properly associated with a label?",
    "link-name":             "Do all links in this snippet have discernible text?",
    "aria-roles":            "Are all ARIA roles used in this snippet valid?",
    "aria-valid-attr-value": "Do all ARIA attributes in this snippet have valid values?",
    "tabindex":              "Are tabindex attribute values appropriately set to prevent keyboard traps?",
    "html-has-lang":         "Does the html element have a lang attribute?",
    "heading-order":         "Is the heading hierarchy logical and ascending?",
    "ident-unique":          "Are all IDs in this snippet unique?",
    "meta-viewport":         "Does this snippet include a usable meta viewport tag?",
    "form-field-multiple-labels": "Does each input have only one associated label?",
    "input-image-alt":       "Does an image-button input have accessible text?",
    "img-alt-formula":       "Does an image used as a form field have accessible text?",
    "no-autocomplete":       "Are form inputs missing autocomplete attributes?",
    "valid-lang":            "Is the language attribute valid and supported?",
    "document-title":        "Does the snippet have a descriptive document title?",
    "html-lang":             "Does the root element have a valid lang attribute?",
    "accesskeys":            "Are accesskey attributes used safely?",
    "focus-order-semantics": "Is the tab order meaningful?",
    "img-redundant-alt":     "Does redundant alt text exist on navigation images?",
    "language-direction":    "Is the text direction appropriate for the language?",
    "video-caption":         "Is there a caption track for video elements?",
    "audio-caption":         "Is there a caption or transcript for audio?",
    "list-role-mismatch":    "Is the ARIA role appropriate for list elements?",
    "parsing":               "Is the HTML syntactically valid?",
    "presentation-role-conflict": "Is there a conflict between role and presentation semantics?",
}

SEMANTIC_BOUNDARIES = [
    "header", "nav", "main", "form", "article",
    "section", "aside", "footer", "dialog", "table",
]

AUDITABLE_TAGS = [
    "a", "button", "input", "select", "textarea",
    "details", "dialog", "iframe",
    "img", "svg", "canvas", "video", "audio", "object",
]


# ── BeautifulSoup helpers ──────────────────────────────────────────────────

def clean_dom(soup: BeautifulSoup) -> BeautifulSoup:
    for tag in soup(["script", "style", "noscript", "meta", "link"]):
        tag.decompose()
    for svg in soup.find_all("svg"):
        title = svg.find("title")
        desc = svg.find("desc")
        svg.clear()
        if title:
            svg.append(title)
        if desc:
            svg.append(desc)
        svg.append(soup.new_string("<!-- SVG paths removed -->"))
    for element in soup(text=lambda text: isinstance(text, Comment)):
        element.extract()
    return soup


def count_tokens(text: str, tokenizer) -> int:
    return len(tokenizer.encode(text))


def is_auditable(soup: BeautifulSoup) -> bool:
    if soup.get_text(strip=True):
        return True
    if soup.find(AUDITABLE_TAGS):
        return True
    if soup.find(attrs={"tabindex": True}):
        return True
    if soup.find(attrs={"role": True}):
        return True
    return False


def chunk_node(node, tokenizer, max_tokens: int) -> list[str]:
    node_html = str(node)
    if count_tokens(node_html, tokenizer) <= max_tokens:
        return [node_html]
    from bs4.element import NavigableString

    if isinstance(node, NavigableString):
        return [node_html[:max_tokens * 3]]

    parent_open = f"<{node.name}"
    for attr, value in node.attrs.items():
        if isinstance(value, list):
            value = " ".join(value)
        parent_open += f' {attr}="{value}"'
    parent_open += ">"
    parent_close = f"</{node.name}>"
    wrapper_tokens = count_tokens(parent_open + parent_close, tokenizer)

    chunks = []
    current: list[str] = []
    current_tokens = 0

    for child in node.children:
        child_html = str(child)
        child_tokens = count_tokens(child_html, tokenizer)

        if child_tokens > (max_tokens - wrapper_tokens):
            if current:
                chunks.append(parent_open + "".join(current) + parent_close)
                current = []
                current_tokens = 0
            chunks.extend(chunk_node(child, tokenizer, max_tokens))

        elif current_tokens + child_tokens + wrapper_tokens > max_tokens:
            chunks.append(parent_open + "".join(current) + parent_close)
            current = [child_html]
            current_tokens = child_tokens
        else:
            current.append(child_html)
            current_tokens += child_tokens

    if current:
        chunks.append(parent_open + "".join(current) + parent_close)

    return chunks


def semantic_chunk(html_content: str, tokenizer, max_tokens: int) -> list[str]:
    soup = clean_dom(BeautifulSoup(html_content, "html.parser"))
    body = soup.find("body")
    if not body:
        return []

    final: list[str] = []

    # Process semantic boundary elements (extracts them so body pass doesn't duplicate)
    for tag_name in SEMANTIC_BOUNDARIES:
        for el in body.find_all(tag_name, recursive=True):
            extracted = el.extract()
            html_str = str(extracted)
            if count_tokens(html_str, tokenizer) <= max_tokens:
                final.append(html_str)
            else:
                final.extend(chunk_node(extracted, tokenizer, max_tokens))

    # Body now contains only content NOT inside semantic tags.
    body_content = body.decode_contents()
    body_tokens = count_tokens(body_content, tokenizer)

    if body_tokens <= max_tokens:
        final.append(body_content)
    else:
        # Chunk with body wrapper, then strip the wrapper from each chunk
        wrapped_chunks = chunk_node(body, tokenizer, max_tokens)
        final.extend(c.replace("<body>", "").replace("</body>", "") for c in wrapped_chunks)

    return [c for c in final if is_auditable(BeautifulSoup(c, "html.parser"))]


# ── Axe-core pipeline ───────────────────────────────────────────────────────

def run_axe_audit(page) -> dict:
    """Returns state_map where each key is HTML and value maps rule_id → {status, description}."""
    axe = Axe()
    results = axe.run(page)

    state_map: dict[str, dict[str, dict[str, any]]] = defaultdict(dict)

    def process(rules_list, is_pass: bool):
        for rule in rules_list:
            rule_id = rule.get("id")
            if rule_id == "color-contrast":
                continue
            description = rule.get("description", "")
            status = 1 if is_pass else 0
            for node in rule.get("nodes", []):
                html = node.get("html")
                if html:
                    state_map[html][rule_id] = {"status": status, "description": description}

    # AxeResults stores data in self.response
    response = results.response
    process(response.get("passes", []), is_pass=True)
    process(response.get("violations", []), is_pass=False)
    return dict(state_map)


def generate_instruction(rule_id: str, description: str) -> str:
    return RULE_QUESTIONS.get(rule_id, f"Does this snippet meet the requirement: {description}?")


def state_map_to_jsonl(state_map: dict, output_path: str) -> int:
    written = 0
    with open(output_path, "w", encoding="utf-8") as f:
        for state_html, rules in state_map.items():
            questions = {
                rid: {"type": "noul", "instructions": generate_instruction(rid, rdata["description"])}
                for rid, rdata in rules.items()
            }
            answers = {
                rid: {"type": "noul", "noul": rdata["status"]}
                for rid, rdata in rules.items()
            }
            row = {"state": state_html, "questions": questions, "answers": answers}
            f.write(json.dumps(row) + "\n")
            written += 1
    return written


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generate WCAG training data")
    parser.add_argument("--url", required=True, help="URL to audit")
    parser.add_argument("--output", default="data/wcag/train.jsonl", help="Output JSONL path")
    parser.add_argument("--max-tokens", type=int, default=3000, help="Max tokens per chunk")
    parser.add_argument("--test-split", type=float, default=0.2, help="Fraction for test set")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    # Import tokenizer lazily
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained("Qwen/Qwen1.5-1.8B")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Fetching {args.url} ...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)

        print("Running axe-core audit ...")
        state_map = run_axe_audit(page)

        browser.close()

    print(f"Axe found {len(state_map)} unique HTML states.")

    # Shuffle and split
    items = list(state_map.items())
    random.seed(args.seed)
    random.shuffle(items)

    split = int(len(items) * (1 - args.test_split))
    train_items = items[:split]
    test_items = items[split:]

    # Write train
    train_path = output_path
    test_path = output_path.parent / "test.jsonl"
    written = state_map_to_jsonl(dict(train_items), train_path)
    print(f"Train: {written} rows → {train_path}")

    if test_items:
        written_test = state_map_to_jsonl(dict(test_items), test_path)
        print(f"Test:  {written_test} rows → {test_path}")

    # Print rule distribution
    rule_counts: dict[str, tuple[int, int]] = defaultdict(lambda: (0, 0))
    for _, rules in state_map.items():
        for rid, rdata in rules.items():
            rule_counts[rid][1] += 1
            if rdata["status"] == 0:
                rule_counts[rid][0] += 1

    print("\nRule distribution (violations, total):")
    for rid, (violations, total) in sorted(rule_counts.items(), key=lambda x: -x[1][0] / max(x[1][1], 1)):
        q = RULE_QUESTIONS.get(rid, rid)
        print(f"  {rid:35s}  {violations:3d}/{total:3d} violations")


if __name__ == "__main__":
    main()
