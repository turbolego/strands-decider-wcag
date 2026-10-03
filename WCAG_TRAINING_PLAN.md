# WCAG 2.2 Violation Detection with Strands Decider

Plan for training a Strands Decider model to classify webpage states as having or not having WCAG 2.2 violations.

## Overview

Strands Decider is a 2B-parameter "system one" model that assigns probabilities to fixed-choice options — it does not generate text. This makes it ideal for binary compliance checks: feed it an HTML snippet (the "state") and a set of WCAG rule questions, and it returns a calibrated probability of violation for each. No hallucination, no free-form output, deterministic latency in tens of milliseconds.

The base model is `Qwen/Qwen3.5-2B-Base`. Training adds a LoRA adapter + small readout head (~1M parameters).

---

## Data Pipeline

### 1. Source WCAG Violations

**Primary source: axe-core JSON reports.**

Install axe-core in a headless browser or use the [axe-core npm package](https://github.com/dequelabs/axe-core) to scan URLs and extract structured violation reports. Each violation includes:

- **Rule ID** (e.g. `wcag2a`, `wcag21a`, `wcag22aa`, `wcag313`, `wcag258`)
- **Impact** (critical, serious, moderate, minor)
- **Element** (the specific DOM node)
- **Help text** (the WCAG success criterion description)
- **Target selector** or inline DOM snippet

**Secondary sources:**
- [ axe-core WebDriverIO](https://github.com/dequelabs/axe-webdriverio) — run axe-core programmatically
- [axe-core Puppeteer](https://github.com/dequelabs/axe-puppeteer) — same, with Puppeteer
- Manual curated set of known-good/bad DOM snippets from the [WAI WCAG examples](https://www.w3.org/WAI/WCAG21/Techniques/html/)
- Kaggle: ["Web Accessibility Compliance Dataset"](https://www.kaggle.com/search?q=web+accessibility+compliance) (search for axe-core exports on public websites)

### 2. Extract States

The full DOM exceeds typical context windows (3072–4096 tokens). Chunk into localized "states" — DOM snippets that contain the relevant element plus enough surrounding context to understand layout.

**Example — WCAG 2.5.8 Target Size:**

```html
<div class="nav-menu">
  <button style="width: 20px; height: 20px; padding: 0;">Login</button>
  <button style="width: 20px; height: 20px; padding: 0;">Help</button>
</div>
```

**Example — Focus Indicator (2.4.7):**

```html
<input type="text" placeholder="Search..." class="search-input">
```

**Example — Color Contrast (1.4.3):**

```html
<span style="color: #999;">Disabled option text</span>
```

Extract the element's own HTML or its accessibility tree node as the state. For complex rules (e.g. ARIA states, form validation), include the relevant DOM fragment.

### 3. Structure Training Examples

Each row is a JSONL object with `state`, `questions`, and `answers`. Use the `noul` (yes/no) question type for every WCAG criterion.

**Single-rule example:**

```json
{
  "state": "<div class=\"nav-menu\">\n  <button style=\"width: 20px; height: 20px; padding: 0;\">Login</button>\n</div>",
  "questions": {
    "wcag_2_5_8_target_size": {
      "type": "noul",
      "instructions": "Does this HTML snippet meet the WCAG 2.2 minimum target size of 24×24 CSS pixels for interactive elements?"
    }
  },
  "answers": {
    "wcag_2_5_8_target_size": {
      "type": "noul",
      "noul": 0
    }
  }
}
```

**Multi-rule example (recommended — feed state once, ask 5–10 rules):**

```json
{
  "state": "<input type=\"text\" placeholder=\"Enter code from app\">",
  "questions": {
    "wcag_2_5_8_target_size": {
      "type": "noul",
      "instructions": "Does this input require the user to enter a value that the app previously provided? (WCAG 3.3.7 Accessible Authentication)"
    },
    "wcag_3_3_2_labels_or_instructions": {
      "type": "noul",
      "instructions": "Does this input have an associated label or aria-label describing its purpose? (WCAG 3.3.2 Labels or Instructions)"
    },
    "wcag_1_4_3_contrast_minimum": {
      "type": "noul",
      "instructions": "Is the text color of this input's placeholder contrasting at least 4.5:1 with its background? (WCAG 1.4.3 Contrast — AA)"
    },
    "wcag_2_4_7_focus_visible": {
      "type": "noul",
      "instructions": "Does this input have a visible focus indicator when focused? (WCAG 2.4.7 Focus Visible)"
    },
    "wcag_1_1_1_nontext_content": {
      "type": "noul",
      "instructions": "Does this input have a non-text form of label (e.g. icon + aria-label) since placeholder text alone is not sufficient? (WCAG 1.1.1)"
    }
  },
  "answers": {
    "wcag_2_5_8_target_size": { "type": "noul", "noul": 0 },
    "wcag_3_3_2_labels_or_instructions": { "type": "noul", "noul": 0 },
    "wcag_1_4_3_contrast_minimum": { "type": "noul", "noul": 0 },
    "wcag_2_4_7_focus_visible": { "type": "noul", "noul": 0 },
    "wcag_1_1_1_nontext_content": { "type": "noul", "noul": 0 }
  }
}
```

### 4. Label Conventions

| Field | Value | Meaning |
|---|---|---|
| `noul` | `0` | Violation — does NOT meet the criterion |
| `noul` | `1` | Pass — meets the criterion |

`noul: 0.5` = uncertain, treat as violation for conservative compliance checking.

---

## Coverage Target

### WCAG 2.2 Rules to Target (priority order)

**Automated-detectable via DOM inspection:**

| Rule | Description | Difficulty |
|---|---|---|
| 1.1.1 Non-text Content | img/area/button needs alt; decorative has aria-hidden | High |
| 1.3.1 Info and Relationships | ARIA labels match visible text | High |
| 1.3.2 Meaningful Sequence | DOM order matches visual order | Medium |
| 1.3.3 Sensory Characteristics | Instructions don't rely solely on color/shape | High |
| 1.4.3 Contrast (Minimum) | 4.5:1 for normal text | Medium |
| 1.4.4 Resize Text | 200% zoom doesn't break layout | High |
| 1.4.10 Reflow | 320px viewport doesn't require horizontal scroll | Medium |
| 1.4.11 Non-text Contrast | 3:1 for UI components | Medium |
| 1.4.12 Text Spacing | Custom spacing doesn't break content | Low |
| 1.4.13 Content on Hover/Focus | Hover/focus content is accessible | Medium |
| 2.4.6 Headings and Labels | Labels describe topic | Medium |
| 2.4.7 Focus Visible | Focus indicator is visible | High |
| 2.5.5 Target Size | Interactive targets ≥ 24×24px | Medium |
| 2.5.6 Concurrent Input Mechanisms | Not applicable to web | N/A |
| 3.1.1 Language of Page | `<html lang>` present | High |
| 3.1.2 Language of Parts | `lang` attr on non-default content | High |
| 3.2.3 Consistent Navigation | Same navigation on same pages | Medium |
| 3.2.4 Consistent Identification | Same component = same ID | Medium |
| 3.3.1 Error Identification | Errors are clearly identified | High |
| 3.3.2 Labels or Instructions | All inputs have labels | High |
| 3.3.3 Error Suggestion | Error messages suggest correction | Medium |
| 3.3.4 Error Prevention (Legal) | Legal commitments are reversible | Low |
| 3.3.5 Help | Help text provided for complex inputs | Medium |
| 3.3.6 Error Prevention (General) | Submissions are reversible | Low |
| 3.3.7 Accessible Authentication | No cognitive test on login | Medium |
| 3.3.8 Accessible Authentication (Enhanced) | No cognitive test + 2FA | Low |
| 3.4.1 Unique Page Title | `<title>` is unique and descriptive | Medium |
| 3.4.2 Page Titled | `<title>` exists and is non-empty | High |
| 3.5.1 Help View | Help is accessible on all pages | Low |
| 3.5.2 Error Prevention (Legal) | Legal commitments are reversible | Low |

**Requires accessibility tree or user testing:**

| Rule | Description | Difficulty |
|---|---|---|
| 1.1.1 (complex images) | Complex images need long descriptions | High |
| 1.2.1 Audio/Video (captions) | Captions provided for audio/video | Low |
| 1.2.2 Captions (pre-recorded) | Captions for pre-recorded video | Low |
| 1.2.3 Audio Description | Description track for video | Low |
| 1.2.4 Captions (live) | Live captioning provided | Low |
| 1.2.5 Audio Description | Description track for prerecorded | Low |
| 4.1.1 Parsing | DOM is valid and parsable | High |
| 4.1.2 Name, Role, Value | Custom widgets have proper ARIA | High |
| 4.1.3 Status Messages | Dynamic updates are announced | Medium |
| 4.1.4 Character Key Shortcuts | Keyboard shortcuts are avoidable | Low |
| 4.1.5 Non-text Contrast | 3:1 for UI components at 200% | Medium |
| 4.1.6 Non-text Contrast | 3:1 for user interface components | Medium |
| 4.1.7 Motion Actuation | Motion doesn't trigger interactions | Low |
| 4.1.8 Contrast (UI) | 3:1 for graphical objects | Medium |
| 4.1.9 Contrast (UI) | 3:1 for text inside graphical objects | Medium |
| 4.1.10 Reflow | Same 4:1 ratio at 400% zoom | Medium |
| 4.1.11 Focus Visible (Enhanced) | Focus indicator ≥ 3:1 | Low |
| 4.1.12 Focus Visible (Enhanced) | Focus indicator ≥ 4.5:1 + visible focus ring | Low |
| 4.1.13 Content on Hover/Focus (Enhanced) | Hover/focus content persists | Low |
| 4.1.14 Resize Text (Enhanced) | Same 4:1 ratio at 400% zoom | Medium |
| 4.1.15 Focus Appearance (Enhanced) | Focus indicator ≥ 3:1 + 2px or 3px thick | Low |
| 4.1.16 Focus Appearance (Enhanced) | Focus indicator ≥ 4.5:1 + 2px or 3px thick | Low |
| 4.1.17 Focus Appearance (Enhanced) | Focus indicator ≥ 3:1 + 2px or 3px thick, ≥ 1px | Low |
| 4.1.18 Focus Appearance (Enhanced) | Focus indicator ≥ 4.5:1 + 2px or 3px thick | Low |
| 4.1.19 Focus Appearance (Enhanced) | Focus indicator ≥ 3:1 + ≥ 3px thick | Low |
| 4.1.20 Focus Appearance (Enhanced) | Focus indicator ≥ 4.5:1 + ≥ 3px thick | Low |
| 4.1.21 Focus Appearance (Enhanced) | Focus indicator ≥ 3:1 + ≥ 4px thick | Low |
| 4.1.22 Focus Appearance (Enhanced) | Focus indicator ≥ 4.5:1 + ≥ 4px thick | Low |
| 4.1.23 Focus Appearance (Enhanced) | Focus indicator ≥ 3:1 + ≥ 1px | Low |
| 4.1.24 Focus Appearance (Enhanced) | Focus indicator ≥ 4.5:1 + ≥ 1px | Low |
| 4.1.25 Focus Appearance (Enhanced) | Focus indicator ≥ 3:1 + ≥ 2px or 3px thick | Low |
| 4.1.26 Focus Appearance (Enhanced) | Focus indicator ≥ 4.5:1 + ≥ 2px or 3px thick | Low |
| 4.1.27 Focus Appearance (Enhanced) | Focus indicator ≥ 3:1 + ≥ 2px or 3px thick, ≥ 1px thick | Low |
| 4.1.28 Focus Appearance (Enhanced) | Focus indicator ≥ 4.5:1 + ≥ 2px or 3px thick, ≥ 1px thick | Low |

### Key Rules for Initial Training (high automation, high impact)

Start with these 10–12 rules to bootstrap the model, then expand:

1. **1.1.1 Non-text Content** (icon buttons missing aria-label)
2. **1.3.1 Info and Relationships** (aria-label ≠ visible text)
3. **1.3.3 Sensory Characteristics** (color-only instructions)
4. **1.4.3 Contrast** (text color too light against background)
5. **1.4.10 Reflow** (horizontal scroll at 400% zoom)
6. **2.4.6 Headings and Labels** (empty headings, generic labels)
7. **2.4.7 Focus Visible** (outline: none, invisible focus)
8. **2.5.5 Target Size** (buttons < 24×24px)
9. **3.1.1 Language of Page** (missing or wrong `<html lang>`)
10. **3.1.2 Language of Parts** (unmarked language changes)
11. **3.3.1 Error Identification** (error messages hidden/not linked to inputs)
12. **3.3.2 Labels or Instructions** (inputs without labels)
13. **3.3.7 Accessible Authentication** (captcha-only login)

---

## Training Pipeline

### Hardware

- **Minimal:** 1× NVIDIA GPU with ≥8 GB VRAM (RTX 3090, A5000, or equivalent)
- **Recommended:** 1× NVIDIA H100 80GB for faster training
- **Kaggle:** P100 (16 GB) works but may require smaller batch size; plan for ~16h training

### Setup

```bash
# Clone the fork (this repo)
git clone https://github.com/turbolego/strands-decider-wcag.git
cd strands-decider-wcag

# Install with training extras
pip install -e ".[train]"

# Install pinned GPU libraries
pip install torch flash-linear-attention
```

### Step 1: Build WCAG Training Corpus

Place your formatted `.jsonl` file in `data/wcag/` and use the `strands-decider data build` command, or add a generator script to `data/generators/`.

**Recommended approach:** Create a custom generator at `data/generators/gen_wcag/` that:
1. Reads axe-core JSON report files from `data/raw/wcag-violations/`
2. Extracts states (DOM snippets) for each violation
3. Maps violation rule IDs to WCAG question names
4. Outputs `gen_train.jsonl` and `gen_eval.jsonl`

```bash
# Create the generator directory
mkdir -p data/generators/gen_wcag
```

### Step 2: Run Training

```bash
# On a single GPU
export NGPU=1
bash training/recipe.sh all
```

The recipe runs these stages:

| Stage | What it does |
|---|---|
| `build` | Converts HuggingFace datasets + custom generators into `.jsonl` files |
| `fetch` | Downloads upstream datasets (ContractNLI, MuSiQue) |
| `multistep` | Processes multi-step training rows |
| `generated` | Processes LLM-generated synthetic data |
| `adequacy` | Processes answer-adequacy rows |
| `teacher` | Computes frozen teacher (Qwen3.5-4B) distributions |
| `parent` | Trains parent model (~5h on RTX 3090) |
| `replay` | Replays parent distributions for multi-step rows (~40min) |
| `train` | Trains final model (~6h on RTX 3090) |
| `calibrate` | Calibrates confidence scores |
| `eval` | Evaluates on held-out sets |

**Estimated times:**
- RTX 3090 (24 GB): ~11 hours total
- Kaggle P100 (16 GB): ~12–16 hours (may need checkpoint/resume for the 12h session limit)

### Step 3: Serve and Test

```bash
# Serve the trained model
strands-decider serve ./checkpoints/hobson-2b-recipe --port 8000 &

# Test against a snippet
curl -s localhost:8000/v1/systemone \
  -H 'content-type: application/json' \
  -d '{
    "state": "<button style=\"width: 20px; height: 20px;\">Login</button>",
    "questions": {
      "wcag_2_5_8_target_size": {
        "type": "noul",
        "instructions": "Does this button meet the WCAG 2.2 minimum target size of 24×24 CSS pixels?"
      }
    }
  }'
```

**Expected response:**
```json
{
  "model": "strands-decider-2B-wcag",
  "answers": {
    "wcag_2_5_8_target_size": {
      "type": "noul",
      "noul": 0.02
    }
  },
  "usage": { "input_tokens": 65, "output_tokens": 1 },
  "latency_ms": 140.03
}
```

`noul: 0.02` → very low probability of passing → likely violation.
`noul: 0.95` → high probability of passing → likely compliant.

### Step 4: Confidence Thresholds for Production

Use calibrated confidence scores to gate decisions:

| Confidence | Action |
|---|---|
| ≥ 0.90 | Auto-approve (clearly compliant) |
| 0.70–0.90 | Flag for review (ambiguous) |
| < 0.70 | Auto-fail (likely violation) |

**Implementation pattern:**
```python
VIOLATION_THRESHOLD = 0.30   # noul < 0.30 → violation
PASS_THRESHOLD = 0.70        # noul > 0.70 → pass

result = model.decide(state=html_snippet, questions=wcag_questions)
for rule, answer in result.answers.items():
    if answer.noul < VIOLATION_THRESHOLD:
        print(f"VIOLATION: {rule} (confidence: {answer.noul:.2f})")
    elif answer.noul > PASS_THRESHOLD:
        print(f"PASS: {rule} (confidence: {answer.noul:.2f})")
    else:
        print(f"UNCERTAIN: {rule} (confidence: {answer.noul:.2f}) — needs human review")
```

---

## Multi-QA Optimization

Feed the state **once** and ask multiple WCAG questions simultaneously — Strands Decider reads the state once and evaluates all questions in a single forward pass.

```python
questions = {
    "wcag_2_5_8_target_size": {
        "type": "noul",
        "instructions": "Does this button meet the 24×24 CSS pixel minimum?"
    },
    "wcag_1_4_3_contrast_minimum": {
        "type": "noul",
        "instructions": "Does the text contrast at least 4.5:1 with its background?"
    },
    "wcag_2_4_7_focus_visible": {
        "type": "noul",
        "instructions": "Does this input have a visible focus indicator?"
    },
    # ... up to 10+ questions per state
}
```

This is the key efficiency advantage over sequential LLM calls.

---

## Validation and Evaluation

### Ground Truth

1. **Axe-core scans** of known-good websites (e.g. w3.org, gov.uk, BBC) → should get mostly passes
2. **Axe-core scans** of known-bad websites → should get mostly violations
3. **Manual audit** of edge cases by accessibility experts

### Metrics

- **Accuracy** per rule: fraction of correct predictions on held-out test set
- **Calibration** (Expected Calibration Error): are confidence scores reliable?
- **Coverage**: how many WCAG 2.2 rules can the model evaluate?
- **Latency**: time per decision (should be < 500ms)
- **False negative rate**: critical for compliance — missing a violation is worse than a false alarm

### Confidence Calibration

Strands Decider includes a calibration step (`training/recipe.sh` stages 10–11). After calibration, the model's confidence scores should be well-calibrated:
- `noul: 0.9` → should be correct ~90% of the time
- `noul: 0.1` → should be correct ~90% of the time

---

## Repository Structure (this fork)

```
data/
  wcag/                  # WCAG training data (JSONL)
    train.jsonl           # Training examples
    eval.jsonl            # Evaluation examples
  generators/
    gen_wcag/             # WCAG-specific data generator
      gen_train.jsonl
      gen_eval.jsonl
      README.md
      generate.py         # Reads axe-core reports → training rows
      verify.py           # Consistency checks
      export.py           # Format for training

training/
  wcag_recipe.sh          # Simplified training recipe (WCAG-only)
  recipe.sh               # Full recipe with WCAG stages added

src/strands_decider/
  # (upstream code — do not modify)
```

---

## Quick Start Commands

```bash
# Full pipeline in one session
cd strands-decider-wcag
pip install -e ".[train]" && pip install torch flash-linear-attention

# Place your axe-core JSON reports in data/raw/wcag-violations/
# Then generate training data
python data/generators/gen_wcag/generate.py data/raw/wcag-violations/ data/wcag/

# Build corpus
export NGPU=1
bash training/recipe.sh all

# Serve
strands-decider serve ./checkpoints/hobson-2b-wcag --port 8000 &
```

---

## References

- [Strands Decider GitHub](https://github.com/strands-labs/strands-decider) — upstream repo
- [Strands Decider PyPI](https://pypi.org/project/strands-decider/) — install + usage
- [Axe-core](https://github.com/dequelabs/axe-core) — WCAG scanning engine
- [WCAG 2.2 Guidelines](https://www.w3.org/WAI/WCAG22/quickref/) — rule reference
- [Kaggle: Web Accessibility Compliance Dataset](https://www.kaggle.com/search?q=web+accessibility+compliance) — public axe-core exports

## Semantic HTML Chunking

When evaluating a full webpage DOM, you cannot split HTML arbitrarily (e.g., every 3000 tokens) because doing so might sever an `<input>` from its `<label>`, or an `aria-controls` ID from its target, producing false positives.

Strands Decider's torso uses the Qwen3.5-2B architecture, so chunk sizes must be measured with Qwen's tokenizer. The following parser uses BeautifulSoup to strip accessibility-irrelevant noise, target semantic HTML5 landmarks, and recursively chunk elements that exceed the token limit while preserving HTML structure.

### The Chunker Script

```python
import warnings
from bs4 import BeautifulSoup, NavigableString
from transformers import AutoTokenizer

warnings.filterwarnings("ignore")

class SemanticHTMLChunker:
    def __init__(self, model_name="Qwen/Qwen1.5-1.8B", max_tokens=3500):
        # 3500 tokens leaves ~500 for prompt + questions
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.max_tokens = max_tokens

        self.semantic_boundaries = [
            'header', 'nav', 'main', 'form', 'article',
            'section', 'aside', 'footer', 'dialog', 'table'
        ]

    def count_tokens(self, text: str) -> int:
        return len(self.tokenizer.encode(text))

    def clean_dom(self, html_content: str) -> BeautifulSoup:
        soup = BeautifulSoup(html_content, 'html.parser')

        # Remove tags that bloat tokens without affecting WCAG rules
        for tag in soup(['script', 'style', 'noscript', 'meta', 'link']):
            tag.decompose()

        # SVGs are massive token hogs. Keep title/desc for accessibility checks, gut paths.
        for svg in soup.find_all('svg'):
            title = svg.find('title')
            desc = svg.find('desc')
            svg.clear()
            if title: svg.append(title)
            if desc: svg.append(desc)
            svg.append(soup.new_string("<!-- SVG paths removed -->"))

        # Remove HTML comments
        for element in soup(text=lambda text: isinstance(text, bs4.Comment)):
            element.extract()

        return soup

    def chunk_node(self, node) -> list[str]:
        """Recursively chunks a BeautifulSoup node to fit token limits."""
        node_html = str(node)

        if self.count_tokens(node_html) <= self.max_tokens:
            return [node_html]

        if isinstance(node, NavigableString):
            return [node_html[:self.max_tokens * 3]]

        chunks = []
        current_chunk = []
        current_tokens = 0

        parent_open_tag = f"<{node.name}"
        for attr, value in node.attrs.items():
            if isinstance(value, list):
                value = " ".join(value)
            parent_open_tag += f' {attr}="{value}"'
        parent_open_tag += ">"
        parent_close_tag = f"</{node.name}>"

        wrapper_tokens = self.count_tokens(parent_open_tag + parent_close_tag)

        for child in node.children:
            child_html = str(child)
            child_tokens = self.count_tokens(child_html)

            if child_tokens > (self.max_tokens - wrapper_tokens):
                if current_chunk:
                    html_str = parent_open_tag + "".join(current_chunk) + parent_close_tag
                    chunks.append(html_str)
                    current_chunk = []
                    current_tokens = 0
                chunks.extend(self.chunk_node(child))

            elif current_tokens + child_tokens + wrapper_tokens > self.max_tokens:
                html_str = parent_open_tag + "".join(current_chunk) + parent_close_tag
                chunks.append(html_str)
                current_chunk = [child_html]
                current_tokens = child_tokens
            else:
                current_chunk.append(child_html)
                current_tokens += child_tokens

        if current_chunk:
            html_str = parent_open_tag + "".join(current_chunk) + parent_close_tag
            chunks.append(html_str)

        return chunks

    def process_page(self, html_content: str) -> list[str]:
        soup = self.clean_dom(html_content)
        body = soup.find('body')
        if not body:
            return []

        final_chunks = []

        # Extract semantic landmarks first
        for tag_name in self.semantic_boundaries:
            for el in body.find_all(tag_name, recursive=True):
                extracted = el.extract()
                final_chunks.extend(self.chunk_node(extracted))

        # Process remaining body content
        final_chunks.extend(self.chunk_node(body))

        return final_chunks
```

### How It Works

**Targeted extraction.** The parser hunts for standalone functional areas (`<form>`, `<nav>`, `<main>`). WCAG violations often occur within these units (e.g., an inaccessible login form). Isolating them gives the model focused context without surrounding page clutter.

**SVG gutting.** SVGs contain thousands of `<path>` coordinates that destroy context windows. The script strips geometry but preserves `<title>` and `<desc>` so the model can still audit WCAG 1.1.1 (Non-text Content).

**Parent re-wrapping.** If a large `<main>` must be split, the script rebuilds the parent tags so both chunks are syntactically valid HTML:
```
<main class="layout"> [Chunk 1 content] </main>
<main class="layout"> [Chunk 2 content] </main>
```

### Usage

```python
chunker = SemanticHTMLChunker(max_tokens=3000)
states = chunker.process_page(html_content)

for i, state in enumerate(states):
    token_count = chunker.count_tokens(state)
    print(f"State {i+1}: {token_count} tokens")
    # Feed state into training data JSONL
```

### Integration with Training Pipeline

The chunker feeds into step 2 (Extract and Format Webpage States) of the training plan. Each chunk becomes one `state` field in a training row:

```json
{
  "state": "<form class="login">
  <label for="email">Email</label>
  <input id="email" type="text">
</form>",
  "questions": { "wcag_3_3_2_labels": { "type": "noul", "instructions": "Does every input have a label?" } },
  "answers": { "wcag_3_3_2_labels": { "type": "noul", "noul": 0 } }
}
```
