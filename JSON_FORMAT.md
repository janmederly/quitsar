# Question-bank compatibility specification · 1.0

This is the complete, human-editable bank contract for quitsar. Save UTF-8 `.json`. All imported JSON is **untrusted data**, never executable JavaScript/HTML/CSS. Text is rendered literally; Markdown/HTML formatting is not evaluated. The complete original educational demo is [`banks/demo.json`](banks/demo.json).

The import screen’s **Format & AI guide** includes a copyable AI prompt, a field reference, the [JSON Schema](assets/question-bank.schema.json), and a [four-type example](assets/question-bank.example.json). The schema describes structural constraints; the app additionally checks unique IDs, topic references, real dates, and file-size limits. Image files are selected separately.

## Envelope and versioning

```json
{
  "schemaVersion": "1.0",
  "bank": {
    "id": "my-bank",
    "title": "My bank",
    "version": "1.0.0",
    "language": "en",
    "topics": []
  },
  "questions": []
}
```

This structural fragment must be filled with at least one declared topic and question before import. `schemaVersion` is exactly the string `"1.0"`. Unsupported versions are rejected, not guessed or automatically rewritten. Bank content `bank.version` is a separate, nonempty string chosen by the author (semantic versioning recommended). Internal IndexedDB version 1 and backup envelope version 1 are separate contracts.

IDs throughout are strings of 1–100 ASCII letters/digits/dots/underscores/hyphens; the first character must be a letter or digit. IDs are case-sensitive. Bank IDs should be globally distinctive, e.g. `my-course-algebra-2026`. Question IDs are unique **within a bank**, topic IDs within the bank, subtopic IDs within their parent topic, option IDs within the question. Never assign a stable question ID to materially different content if you want independent study history.

Unknown fields are allowed for forward-compatible author metadata but ignored by the app. Recognized fields must satisfy this specification. Do not depend on unknown fields being interpreted. No JSON field is interpreted as a resource URL except the validated local image-path convention.

## Bank fields

| Field                              | Required | Type / rule                                                                 |
| ---------------------------------- | -------- | --------------------------------------------------------------------------- |
| `schemaVersion`                    | Yes      | String, exactly `1.0`                                                       |
| `bank`                             | Yes      | Object                                                                      |
| `bank.id`                          | Yes      | ID as above; an existing ID triggers a confirmed update                     |
| `bank.title`                       | Yes      | Nonempty text, ≤300 characters                                              |
| `bank.version`                     | Yes      | Nonempty text, ≤100 characters                                              |
| `bank.language`                    | Yes      | Nonempty text, ≤40 characters; BCP 47 recommended, e.g. `en`, `sk`, `en-GB` |
| `bank.description`                 | No       | Text, ≤30,000 characters                                                    |
| `bank.author`                      | No       | Text, ≤30,000 characters                                                    |
| `bank.license`                     | No       | Text, ≤30,000 characters; include permission to use content                 |
| `bank.createdAt`, `bank.updatedAt` | No       | Real calendar dates exactly `YYYY-MM-DD`                                    |
| `bank.topics`                      | Yes      | Array of topic objects                                                      |
| `questions`                        | Yes      | Array, 1–20,000 question objects                                            |

Each topic is `{ "id": "topic-id", "title": "Topic title", "subtopics": [...] }`. ID and nonempty title (≤300 characters) are required; subtopics are optional. Each subtopic has required `id` and `title` with the same rules. Duplicate subtopic IDs under different parent topics are allowed. Every question must refer to a declared topic. If a subtopic is provided, it must belong to that question's topic.

## Common question fields

| Field         | Required                     | Type / rule                                                           |
| ------------- | ---------------------------- | --------------------------------------------------------------------- |
| `id`          | Yes                          | Stable unique question ID within this bank                            |
| `type`        | Yes                          | `open_ended`, `single_choice`, `multiple_choice`, `image_recognition` |
| `topicId`     | Yes                          | Declared topic ID                                                     |
| `subtopicId`  | No                           | Declared subtopic ID within `topicId`                                 |
| `prompt`      | Yes                          | Nonempty text, ≤30,000 characters                                     |
| `explanation` | Yes                          | Nonempty detailed text, ≤30,000 characters                            |
| `difficulty`  | Yes                          | `easy`, `medium` or `hard`                                            |
| `tags`        | No                           | Array of nonempty strings, each ≤100 characters                       |
| `images`      | No, except image recognition | Array of local image objects                                          |
| `source`      | No                           | Object with string-valued fields, each ≤3,000 characters              |

Optional fields may be omitted; `null` is not a substitute for an omitted array/string/object. Empty optional strings are accepted but should be omitted for clarity. All required text is checked after trimming for emptiness. String length limits use JavaScript UTF-16 code units. A whole bank JSON file is limited to 512 KiB. A serialized saved bank, including images, must fit in 1 MiB.

Recommended source keys: `title`, `reference`, `pageOrSlide`, `notes`. Additional string keys such as `page`, `slide`, `chapter`, `edition` or `doi` are allowed and rendered as labeled text. Use strings for page/slide numbers, e.g. `"12–14"`, not numbers. References are never fetched and are not automatically made into links. Source title is available as a filter.

## Four exact types

### Open-ended: `open_ended`

Requires `acceptedAnswer`, an object with:

- `display`: official nonempty answer, ≤30,000 characters.
- `aliases`: optional array of nonempty strings, each ≤1,000 characters.
- `feedback`: optional text, ≤30,000 characters, for answer-specific self-assessment guidance.

Images are optional. `options` is not used for this type. Written answers are never automatically graded or matched against aliases. Reveal shows the official answer, aliases, feedback, explanation and source. Repeat/Know schedules the question; exam self-assessment is separate from objective scores.

### Single-correct: `single_choice`

Requires `options`, an array of 2–100 option objects, exactly one with `isCorrect: true`. Images optional. Native radio selection permits one answer. An intentionally empty answer must be skipped rather than submitted as a study response.

### Multiple-correct: `multiple_choice`

Requires `options`, 2–100 objects, at least one correct. All options may be correct; consider including plausible incorrect options for useful practice. Native checkboxes allow multiple answers. There is no separate `correctOptionIds` array: option-level `isCorrect` is the authoritative answer representation.

### Image recognition: `image_recognition`

Requires at least one `images` object, `options` with 2–100 objects, and `selectionMode` equal to `single` or `multiple`. `single` requires exactly one correct option; `multiple` requires at least one. Rendering/scoring otherwise matches the corresponding choice type. Missing image files do not invalidate the JSON; an inline warning displays their relative path while text/options remain usable.

### Option objects

```json
{
  "id": "stable-a",
  "text": "Answer text",
  "isCorrect": true,
  "rationale": "Why this option is correct or incorrect."
}
```

All four fields are required. ID follows the shared rules; text and rationale are nonempty strings ≤30,000 characters. `isCorrect` is a JSON boolean, never `"true"`, `1` or an answer letter. Options may be reordered without changing identities. Persisted selections refer to these IDs, not array positions.

## Local images

```json
{ "path": "images/animal-cell.webp", "alt": "Description of the relevant visible findings" }
```

Both fields required. Alt is nonempty text ≤2,000 characters and should convey useful visual information. Path is ≤300 characters and must:

- Be relative to the directory of the bank JSON, with forward slashes.
- Use only ASCII letters, digits, `_`, `.`, `/`, spaces and `-`.
- End in `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` (case-insensitive).
- Have no leading slash, empty segment, `.` or `..` segment, backslash, protocol/colon, URL query/hash, percent encoding or system path.

Allowed: `images/slide-12.png`, `diagram.svg`, `figures/cell 1.svg`. Rejected: `../diagram.svg`, `/home/me/diagram.png`, `C:\\images\\x.png`, `https://example.com/x.png`, `data:image/png,...`, `images//x.png`.

Keep files with the bank under `banks/` when using the local server. Select JSON and related images explicitly through the import interface. The browser cannot automatically access sibling files just because JSON names them. The included demo action uses only fixed bundled paths. Arbitrary imported image paths are **never fetched**.

Flat file selection maps an explicitly selected file's unique basename to its declared relative path. Use unique image basenames per selection. Duplicate selected basenames cause an error. Images are stored as sanitized SVG markup or base64 raster data inside bank records (IndexedDB for guests, D1 for accounts), not as absolute filesystem references. Bank JSON exports retain original relative paths but omit binary files; full backups include assets. Limits: 256 KiB per image, 512 KiB selected images per bank, and 1 MiB per serialized bank including encoded images. SVG uses a strict shape/text allowlist, so styles, scripts, links, gradients, filters and embedded assets are removed. Raster signatures must match extensions. No ZIP/folder scan is implemented.

## Complete valid example

This minimal example covers all four types. Attach `diagram.svg` separately or use an existing local safe SVG under that name; missing files produce a warning rather than a schema error.

```json
{
  "schemaVersion": "1.0",
  "bank": {
    "id": "my-foundations",
    "title": "Foundations",
    "description": "Original educational exercises.",
    "language": "en",
    "version": "1.0.0",
    "createdAt": "2026-10-19",
    "topics": [
      { "id": "basics", "title": "Basics", "subtopics": [{ "id": "recall", "title": "Recall" }] }
    ]
  },
  "questions": [
    {
      "id": "q-open",
      "type": "open_ended",
      "topicId": "basics",
      "subtopicId": "recall",
      "prompt": "What does annular mean?",
      "acceptedAnswer": {
        "display": "Ring-shaped.",
        "aliases": ["Circular ring"],
        "feedback": "Describe the shape."
      },
      "explanation": "Annular describes shape rather than cause.",
      "difficulty": "easy",
      "tags": ["morphology"],
      "source": { "title": "My notes", "pageOrSlide": "1" }
    },
    {
      "id": "q-single",
      "type": "single_choice",
      "topicId": "basics",
      "prompt": "Which is a unit of volume?",
      "options": [
        {
          "id": "ml",
          "text": "Milliliter",
          "isCorrect": true,
          "rationale": "Milliliters measure volume."
        },
        { "id": "min", "text": "Minute", "isCorrect": false, "rationale": "Minutes measure time." }
      ],
      "explanation": "Check dimensions when calculating.",
      "difficulty": "easy"
    },
    {
      "id": "q-multi",
      "type": "multiple_choice",
      "topicId": "basics",
      "prompt": "Select the time units.",
      "options": [
        { "id": "sec", "text": "Second", "isCorrect": true, "rationale": "A time unit." },
        { "id": "min", "text": "Minute", "isCorrect": true, "rationale": "A time unit." },
        { "id": "ml", "text": "Milliliter", "isCorrect": false, "rationale": "A volume unit." }
      ],
      "explanation": "A minute comprises sixty seconds.",
      "difficulty": "medium",
      "tags": ["units"]
    },
    {
      "id": "q-image",
      "type": "image_recognition",
      "selectionMode": "single",
      "topicId": "basics",
      "prompt": "Which structure is labeled in your cell diagram?",
      "images": [{ "path": "diagram.svg", "alt": "Simplified cell with its nucleus labeled" }],
      "options": [
        {
          "id": "nucleus",
          "text": "Nucleus",
          "isCorrect": true,
          "rationale": "The diagram labels the central structure."
        },
        {
          "id": "ribosome",
          "text": "Ribosome",
          "isCorrect": false,
          "rationale": "No ribosome is labeled."
        }
      ],
      "explanation": "This is a simplified schematic.",
      "difficulty": "easy"
    }
  ]
}
```

## Scoring compatibility

Strict: award 1 if the selected ID set exactly equals the correct ID set; otherwise 0. Single choice and single-select image recognition partial score equals strict. Multi-select partial:

```text
C  = number of correct options (always ≥1)
TP = selected correct options
FP = selected incorrect options
partialScore = max(0, min(1, TP/C - FP/C))
```

With correct IDs `["a","b"]` and incorrect IDs `["c","d"]`:

| Selected | Strict | Partial |
| -------- | -----: | ------: |
| a,b      |      1 |       1 |
| a        |      0 |     0.5 |
| a,c      |      0 |       0 |
| a,b,c    |      0 |     0.5 |
| c,d      |      0 |       0 |
| none     |      0 |       0 |

Open answers have no automatic score, and never enter objective percentage denominators. They receive a separate self-assessment. The pure `scoreQuestion` function in `js/scoring.js` is the replacement point for an alternative policy; update tests and both documents when changing it.

## Errors and compatibility guidance

Schema errors include bank ID, question ID, JSON field path and explanation, for example:

```text
[bank my-bank; question q-7] questions[6].options: requires exactly one correct option
[bank my-bank; question q-9] questions[8].images[0].path: use a safe relative ... path
```

Malformed JSON is rejected before field validation and includes the parser's syntax error. Common failures: missing `schemaVersion`, unsupported versions, duplicate IDs, an undeclared topic, wrong-parent subtopic, empty explanations/rationales, string booleans, missing open official answer, an impossible date, missing alt text, multiple correct choices in a single question, and unsafe paths. No invalid bank is saved. A multiple-file import handles each bank independently and reports individual outcomes.

### Migration from the initial proposal

The final schema deliberately preserves version `1.0`, `bank`, `questions`, all four type names, `selectionMode`, option-level `isCorrect`, `acceptedAnswer`, images and source representation. No renaming/conversion is required for valid original banks.

Declare every referenced question topic in `bank.topics`. Supply `difficulty`, `explanation` and every option rationale; use string page/slide values. Keep the IDs stable for unchanged content. `acceptedAnswer.feedback` is an optional additive field for the requested answer-specific feedback. Additional source fields are allowed only as strings. Unknown schema versions need an explicit authored migration to this documented format; no automatic migrations are currently defined.

### Hand-editing and automated generation

Use an editor with JSON syntax checking, keep one question per object, prefer short stable meaningful IDs, and avoid embedding formatting/code or confidential information you do not want in plain-text backups. Keep option IDs unchanged when reordering. Increment bank.version for content updates. Validate a generated bank before importing it into your main library. Generators must declare topics first, enforce unique IDs, emit real booleans, include explanations and rationales, keep image assets local, produce helpful alt text, and verify answer correctness independently. Check machine-generated educational content against reliable course materials.
