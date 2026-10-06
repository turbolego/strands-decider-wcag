import * as ort from "./vendor/ort.min.mjs";
import { Tokenizer } from "./vendor/tokenizers.min.mjs";
import { Laya } from "./laya-core.js";

const $ = (id) => document.getElementById(id);
// Two base checkpoints can be offered side by side: the general English model, and (optionally)
// a second one fine-tuned for typed-decision workflows, convaiinnovations/laya-typed-decisions. Each has
// its own folder and manifest. Override a folder with ?modelBase=... / ?modelBaseTyped=... (needs CORS
// if it points elsewhere), or point a deployment at Hugging Face through site-config.json
// ({"modelBase": "...", "modelBaseTyped": "..."}). The typed base is entirely optional: if its
// manifest can't be found, it's left out of the "Base model" list and the page works as before.
const BASES = {
  laya: { label: "Laya (general)", dir: "./model/", param: "modelBase", configKey: "modelBase" },
  typed: { label: "Laya (typed decisions)", dir: "./model-typed/", param: "modelBaseTyped", configKey: "modelBaseTyped" },
};
let MODEL_DIR = BASES.laya.dir;
let MANIFEST = null;
let BASE_KEY = "laya";

const PRESETS = {
  "WCAG 2.2 - Target Size (Button too small)": {
    state: "<button style='width: 16px; height: 16px; padding: 0; margin: 0;'>OK</button>",
    questions: {
      "wcag_2_5_8_target_size": {
        type: "noul",
        instructions: "Does this button meet the minimum target size requirement of 24x24 CSS pixels?",
      }
    }
  },
  "WCAG 2.2 - Focus Visible (Missing focus indicator)": {
    state: "<button style='outline: none;'>Click me</button>",
    questions: {
      "wcag_2_4_7_focus_visible": {
        type: "noul",
        instructions: "Does this button have a visible focus indicator when keyboard focused?",
      }
    }
  },
  "WCAG 2.1.1 - Parsing Error (Unclosed tag)": {
    state: "<div><p>This is a paragraph</div>",
    questions: {
      "wcag_2_1_1_parsing": {
        type: "noul",
        instructions: "Does this HTML parse correctly (well-formed)?",
      }
    }
  },
  "WCAG 1.1.1 - Missing Alt Text": {
    state: "<img src='logo.png'>",
    questions: {
      "wcag_1_1_1_text_alternatives": {
        type: "noul",
        instructions: "Does this image have appropriate text alternatives?",
      }
    }
  },
  "WCAG Compliant Button": {
    state: "<button style='width: 44px; height: 44px;'>Submit</button>",
    questions: {
      "wcag_2_5_8_target_size": {
        type: "noul",
        instructions: "Does this button meet the minimum target size requirement of 24x24 CSS pixels?",
      }
    }
  },
  "Support ticket": {
    state: { ticket: { subject: "App crashes on launch", text: "Since the last update, the app closes as soon as I open it. I have a demo in one hour!" } },
    questions: {
      team: { type: "choice", instructions: "Which team should handle this?", criteria: { bug: "Something is broken", how_to: "A usage question", sales: "Pricing or plans" } },
      urgency: { type: "score", instructions: "How urgent is this?", criteria: ["Can wait", "This week", "Today", "Right now"] },
      angry: { type: "noul", instructions: "The customer sounds angry" },
    }
  },
  "Agent guardrail (two wordings)": {
    state: "Agent plan: run `DELETE FROM customers WHERE last_login < '2020-01-01'` on the production database. No backup has been taken and no human has reviewed this command.",
    questions: {
      safe_without_approval: { type: "noul", instructions: "Is this safe to run without a human approving it first?" },
      destructive: { type: "noul", instructions: "The command is destructive and cannot be undone" },
      needs_human: { type: "noul", instructions: "A human should approve this command before it runs" },
    }
  },
  "Sales lead scoring": {
    state: "Hi, I'm the VP of Engineering at a 400-person logistics company. We're evaluating vendors this quarter, have budget approved, and want a demo next week with our security team.",
    questions: {
      lead_quality: { type: "score", instructions: "How qualified is this sales lead?", criteria: ["Not a fit", "Weak interest", "Some interest", "Strong buying signals"] },
      next_step: { type: "choice", instructions: "What should sales do next?", criteria: { book_demo: "Schedule a demo", nurture: "Add to a nurture campaign", ignore: "No action needed" } },
    }
  },
  "Patient message routing": {
    state: "Patient message: I've had chest tightness and shortness of breath since yesterday. Should I go to the ER?",
    questions: {
      urgency: { type: "score", instructions: "How urgent is this?", criteria: ["Can wait for appointment", "See doctor today", "Go to urgent care", "Go to ER now"] },
      specialty: { type: "choice", instructions: "Which specialty should see this?", criteria: { cardiology: "Heart/Cardiology", pulmonology: "Lungs/Respiratory", gastroenterology: "Digestive/GI", primary_care: "Primary Care/Family Medicine" } },
    }
  },
  "Content moderation": {
    state: "User comment: \"I hate how this company treats their employees. They should all be fired and the building burned down.\"",
    questions: {
      toxicity: { type: "noul", instructions: "Does this contain hate speech or violent threats?" },
      harassment: { type: "noul", instructions: "Does this target a protected characteristic?" },
      action: { type: "choice", instructions: "What action should be taken?", criteria: { allow: "Allow as-is", warn: "Issue warning", delete: "Delete comment", ban: "Ban user" } },
    }
  }
};

// Rest of the file remains the same...
async function fetchBytes(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return await resp.arrayBuffer();
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return await resp.text();
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return await resp.json();
}

class Laya {
  constructor() {
    this.tokenizer = null;
    this.session = null;
    this.variants = null;
    this.config = null;
  }

  async load(modelDir, manifest) {
    this.variants = manifest.variants;
    this.config = manifest.config;

    // Load tokenizer files in parallel
    const [tj, tc] = await Promise.all([
      fetchJson(`${modelDir}/tokenizer.json`),
      fetchJson(`${modelDir}/tokenizer_config.json`)
    ]);
    this.tokenizer = new Tokenizer(tj, tc);

    // Create inference session
    const { variants } = manifest;
    const variantKeys = Object.keys(variants);
    const firstVariant = variants[variantKeys[0]];
    const modelUrl = `${modelDir}/${firstVariant.onnx}`;
    this.session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  }

  async systemOne(state, questions) {
    if (!this.session) throw new Error("Model not loaded. Call load() first.");

    // Format input as JSON string (same as Python backend)
    const inputText = JSON.stringify({ state, questions });

    // Tokenize
    const { ids } = this.tokenizer.encode(inputText);
    const inputIds = new Int64Array(ids);
    const attentionMask = new Int64Array(ids.map(x => 1));

    // Prepare inputs
    const feeds = {
      input_ids: new ort.Tensor("int64", inputIds, [1, inputIds.length]),
      attention_mask: new ort.Tensor("int64", attentionMask, [1, attentionMask.length])
    };

    // Run inference
    const results = await this.session.run(feeds);

    // Extract logits (assuming the model returns logits for choice/score/noul)
    // The actual output structure depends on the model - this is simplified
    const logits = Array.from(results[0].data);

    // Process results by question type
    const resultsByQuestion = {};
    let offset = 0;

    for (const [key, question] of Object.entries(questions)) {
      const { type, criteria } = question;
      let result;

      if (type === "choice") {
        const numOptions = Object.keys(criteria).length;
        const optionLogits = logits.slice(offset, offset + numOptions);
        const probs = softmax(optionLogits);
        const options = Object.keys(criteria);
        const optionProbs = {};
        options.forEach((opt, i) => {
          optionProbs[opt] = probs[i];
        });
        const topPick = options[probs.indexOf(Math.max(...probs))];
        result = {
          type: "choice",
          options: optionProbs,
          top_pick: topPick,
          confidence: 1 - entropy(probs)
        };
        offset += numOptions;
      } else if (type === "score") {
        const numSteps = criteria.length;
        const scoreLogits = logits.slice(offset, offset + numSteps);
        const probs = softmax(scoreLogits);
        const stepProbs = {};
        criteria.forEach((step, i) => {
          stepProbs[step] = probs[i];
        });
        // Continuous score: weighted average of step indices
        const continuousScore = probs.reduce((sum, p, i) => sum + p * i, 0) / (probs.length - 1);
        result = {
          type: "score",
          steps: stepProbs,
          score: continuousScore,
          confidence: 1 - entropy(probs)
        };
        offset += numSteps;
      } else if (type === "noul") {
        const noulLogit = logits[offset];
        const notNoulLogit = logits[offset + 1];
        const probs = softmax([noulLogit, notNoulLogit]);
        result = {
          type: "noul",
          yes: probs[0],
          no: probs[1],
          confidence: 1 - entropy(probs)
        };
        offset += 2;
      }
    }

    return resultsByQuestion;
  }
}

// Helper functions
function softmax(logits) {
  const maxLogit = Math.max(...logits);
  const exp = logits.map(x => Math.exp(x - maxLogit));
  const sumExp = exp.reduce((sum, x) => sum + x, 0);
  return exp.map(x => x / sumExp);
}

function entropy(probs) {
  return -probs.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0);
}

// Initialize
const laya = new Laya();

// Check for modelBase in URL or site-config
const urlParams = new URLSearchParams(window.location.search);
let modelBase = urlParams.get("modelBase");
let modelBaseTyped = urlParams.get("modelBaseTyped");

if (!modelBase || !modelBaseTyped) {
  // Try to load site-config.json
  fetch("./site-config.json")
    .then(response => {
      if (response.ok) return response.json();
      throw new Error("site-config.json not found or invalid");
    })
    .then(config => {
      if (config.modelBase) modelBase = config.modelBase;
      if (config.modelBaseTyped) modelBaseTyped = config.modelBaseTyped;
      return initializeModel();
    })
    .catch(err => {
      console.warn("Could not load site-config.json:", err);
      // Use defaults
      initializeModel();
    });
} else {
  initializeModel();
}

async function initializeModel() {
  try {
    await laya.load(
      modelBase || BASES.laya.dir,
      await fetchJson(`${modelBase || BASES.laya.dir}/manifest.json`)
    );
    BASE_KEY = "laya";
    MODEL_DIR = modelBase || BASES.laya.dir;
    MANIFEST = await fetchJson(`${modelBase || BASES.laya.dir}/manifest.json`);
    updateBaseSelect();
  } catch (err) {
    console.error("Failed to load model:", err);
  }
}

function updateBaseSelect() {
  const baseSelect = $("#base");
  baseSelect.innerHTML = "";
  for (const [key, base] of Object.entries(BASES)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = base.label;
    if (key === BASE_KEY) option.selected = true;
    baseSelect.appendChild(option);
  }
}

// UI event handlers
$("#base").addEventListener("change", async () => {
  BASE_KEY = $("#base").value;
  const base = BASES[BASE_KEY];
  MODEL_DIR = base.dir;
  try {
    await laya.load(
      base.dir,
      await fetchJson(`${base.dir}/manifest.json`)
    );
    MANIFEST = await fetchJson(`${base.dir}/manifest.json`);
    // Clear results when switching models
    $("#result").innerHTML = "";
  } catch (err) {
    console.error("Failed to load model:", err);
    $("#result").innerHTML = `<div class="error">Failed to load model: ${err.message}</div>`;
  }
});

$("#preset").addEventListener("change", () => {
  const preset = PRESETS[$("#preset").value];
  if (!preset) return;
  $("#state").value = typeof preset.state === "string" ? preset.state : JSON.stringify(preset.state, null, 2);
  // Questions are handled in the predict function
});

$("#predict").addEventListener("click", async () => {
  try {
    const stateInput = $("#state").value.trim();
    let state;
    try {
      state = JSON.parse(stateInput);
    } catch (e) {
      // If not JSON, treat as plain text for the ticket example
      state = { ticket: { subject: "Input", text: stateInput } };
    }

    // Build questions from preset or custom inputs
    const preset = PRESETS[$("#preset").value];
    let questions = {};
    if (preset) {
      questions = { ...preset.questions };
    } else {
      // For custom questions, we'd need to build from UI - simplified for now
      questions = { 
        "wcag_2_5_8_target_size": { 
          type: "noul", 
          instructions: "Does this button meet the minimum target size requirement of 24x24 CSS pixels?" 
        }
      };
    }

    // Update questions based on custom fields if needed
    // This is simplified - in a real app you'd have dynamic question building

    const result = await laya.systemOne(state, questions);
    displayResult(result);
  } catch (err) {
    console.error("Prediction error:", err);
    $("#result").innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
});

function displayResult(result) {
  let html = "<h3>Results</h3>";
  for (const [questionKey, res] of Object.entries(result)) {
    html += `<div class="result-block">`;
    html += `<h4>${questionKey}</h4>`;
    
    if (res.type === "choice") {
      html += `<p><strong>Top pick:</strong> ${res.top_pick}</p>`;
      html += `<p><strong>Options:</strong></p><ul>`;
      for (const [option, prob] of Object.entries(res.options)) {
        html += `<li>${option}: ${(prob * 100).toFixed(1)}%</li>`;
      }
      html += `</ul>`;
    } else if (res.type === "score") {
      html += `<p><strong>Score:</strong> ${(res.score * 100).toFixed(1)}</p>`;
      html += `<p><strong>Steps:</strong></p><ul>`;
      for (const [step, prob] of Object.entries(res.steps)) {
        html += `<li>${step}: ${(prob * 100).toFixed(1)}%</li>`;
      }
      html += `</ul>`;
    } else if (res.type === "noul") {
      html += `<p><strong>Yes:</strong> ${(res.yes * 100).toFixed(1)}%</p>`;
      html += `<p><strong>No:</strong> ${(res.no * 100).toFixed(1)}%</p>`;
    }
    
    html += `<p><strong>Confidence:</strong> ${(res.confidence * 100).toFixed(1)}%</p>`;
    html += `</div>`;
  }
  $("#result").innerHTML = html;
}

// Initialize page on load
window.addEventListener("load", () => {
  // Set default preset
  $("#preset").value = "WCAG 2.2 - Target Size (Button too small)";
  const preset = PRESETS[$("#preset").value];
  if (preset) {
    $("#state").value = typeof preset.state === "string" ? preset.state : JSON.stringify(preset.state, null, 2);
  }
});