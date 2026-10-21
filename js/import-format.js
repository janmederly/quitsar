import { t } from './i18n.js';
import { el, button, badge, modal, download } from './dom.js';

let guidePromise;
async function loadGuide() {
  if (!guidePromise) {
    guidePromise = Promise.all(
      ['question-bank.schema.json', 'question-bank.example.json'].map(async (name) => {
        const response = await fetch(new URL(`../assets/${name}`, import.meta.url));
        if (!response.ok) throw new Error('Format guide unavailable');
        return response.json();
      })
    ).catch((error) => {
      guidePromise = null;
      throw error;
    });
  }
  return guidePromise;
}

export function buildAiPrompt(schema, example) {
  return `Create a quitsar question-bank JSON file from the study material I provide.
Subject: [enter your subject or attach your notes]
Number of questions: [enter a number, for example 20]
Question language: [enter a language]

Use the JSON Schema and example below as the format contract. Replace the example subject and questions with my material. If essential information is missing, ask before generating.
Return exactly one complete JSON object, without Markdown fences or commentary. I will save it as a UTF-8 .json file and import it into quitsar. Do not output the schema itself or an app backup.

Requirements:
- Set schemaVersion to the string "1.0". Include bank metadata, declared topics, and 1–20,000 questions. Keep the entire JSON under 512 KiB; split large subjects into distinct banks if necessary.
- Use stable, case-sensitive IDs of 1–100 ASCII letters, digits, dots, underscores or hyphens, beginning with a letter or digit. Bank IDs should be distinctive. Question IDs must be unique within the bank; topic IDs within the bank; subtopic IDs within their parent topic; option IDs within their question.
- Every topicId must reference bank.topics; every subtopicId must belong to that question's topic. Include prompt, explanation, and difficulty (easy, medium or hard) on every question.
- open_ended: include acceptedAnswer.display. aliases and feedback are optional. These answers are self-assessed, never automatically graded.
- single_choice: include 2–100 options, exactly one correct. multiple_choice: include 2–100 options, at least one correct. Each option requires id, text, a real boolean isCorrect, and an explanation in rationale.
- image_recognition: include at least one local image and selectionMode (single or multiple), plus options following the corresponding correctness rule. Only use images I actually supply. Otherwise use another question type. Do not invent images or remote image URLs.
- Images need path and useful alt text. Paths must be safe relative SVG/PNG/JPEG/GIF/WebP filenames with forward slashes, not URLs or system paths. Images are selected separately on import: at most 256 KiB each, 512 KiB combined per bank, and 1 MiB for the saved bank including images.
- Optional source values, including page/slide numbers, must be strings. Do not invent citations. Use real YYYY-MM-DD dates if supplied. Omit unused optional fields instead of using null.
- Use plain text; the app does not render Markdown or HTML. Unknown metadata is ignored. Do not invent other answer fields such as correctOptionIds.
- Check that answers, explanations and option rationales agree with my material, and check IDs, references, JSON syntax and all conditional requirements before returning the bank.

JSON SCHEMA (the contract, not the requested output):
${JSON.stringify(schema, null, 2)}

VALID EXAMPLE (shows all four types; its diagram.svg must be supplied separately):
${JSON.stringify(example, null, 2)}

MY STUDY MATERIAL:
[paste your notes or attach your study material here]
`;
}

function copyBlock(title, text, copyLabel, status, wrap = false) {
  const code = el('code', {}, text);
  const pre = el(
    'pre',
    { class: wrap ? 'format-code format-prompt' : 'format-code', tabindex: 0, 'aria-label': title },
    code
  );
  const copy = button(
    copyLabel,
    async () => {
      pre.before(status);
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = t('Copied. Paste it into your AI tool or text editor.');
      } catch {
        pre.focus();
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        status.textContent = t(
          'Automatic copying is unavailable. The text is selected; copy it with Ctrl/Cmd+C.'
        );
      }
    },
    'secondary'
  );
  return el(
    'section',
    { class: 'format-block' },
    el('div', { class: 'section-heading' }, el('h3', {}, title), copy),
    pre
  );
}

function fieldReference(schema) {
  const groups = [
    ['Document fields', '', schema],
    ['Bank fields', 'bank.', schema.properties.bank],
    ['Topic fields', 'bank.topics[].', schema.$defs.topic],
    ['Subtopic fields', 'bank.topics[].subtopics[].', schema.$defs.subtopic],
    ['Question fields', 'questions[].', schema.$defs.question],
    ['Open-ended answer fields', 'questions[].acceptedAnswer.', schema.$defs.acceptedAnswer],
    ['Answer option fields', 'questions[].options[].', schema.$defs.option],
    ['Image fields', 'questions[].images[].', schema.$defs.image],
    ['Source fields', 'questions[].source.', schema.$defs.source]
  ];
  return el(
    'section',
    { class: 'format-reference' },
    el('h3', {}, t('Field reference')),
    el('p', { class: 'muted' }, schema.description),
    el('p', { class: 'muted' }, schema.$defs.id.description),
    groups.map(([title, prefix, group], index) =>
      el(
        'details',
        { open: index === 0 },
        el('summary', {}, t(title)),
        el('p', { class: 'muted' }, group.description),
        el(
          'dl',
          { class: 'format-fields' },
          Object.entries(group.properties).map(([name, rule]) => {
            const definition = rule.$ref ? schema.$defs[rule.$ref.split('/').at(-1)] : rule;
            const conditional =
              group === schema.$defs.question &&
              ['images', 'options', 'acceptedAnswer', 'selectionMode'].includes(name);
            return [
              el(
                'dt',
                {},
                el('code', {}, prefix + name),
                badge(
                  group.required?.includes(name)
                    ? t('Required')
                    : conditional
                      ? t('Depends on question type')
                      : t('Optional')
                )
              ),
              el(
                'dd',
                {},
                el('p', {}, rule.description),
                el(
                  'small',
                  { class: 'muted' },
                  definition.type,
                  rule.enum ? ` · ${rule.enum.join(' / ')}` : '',
                  rule.maxLength ? ` · ${t('Maximum characters')}: ${rule.maxLength}` : ''
                )
              )
            ];
          })
        ),
        group === schema.$defs.source &&
          el(
            'p',
            { class: 'muted' },
            t(
              'Other source keys are allowed; every value must be a string of at most 3,000 characters.'
            )
          )
      )
    )
  );
}

export function showImportFormat() {
  const content = el('div', { class: 'import-format' });
  const dialog = modal(t('Question bank format'), content);
  const title = dialog.querySelector('#modal-title');
  const heading = el('div', { class: 'section-heading format-heading' });
  title.replaceWith(heading);
  heading.append(
    title,
    button(t('Close'), () => dialog.close(), 'subtle')
  );
  async function renderGuide() {
    content.replaceChildren(el('p', { role: 'status' }, t('Loading format guide…')));
    try {
      const [schema, example] = await loadGuide();
      const status = el('p', {
        class: 'format-copy-status',
        role: 'status',
        'aria-live': 'polite'
      });
      content.replaceChildren(
        el(
          'p',
          {},
          t(
            'Copy the AI prompt and paste it into your AI of choice with your notes. Ask it to generate questions, save its JSON response as a .json file, then return here to validate and import it.'
          )
        ),
        el(
          'p',
          { class: 'muted' },
          t(
            'The schema, field descriptions, and AI prompt are in English. Ask your AI to write the questions in any language.'
          )
        ),
        status,
        copyBlock(
          t('AI prompt'),
          buildAiPrompt(schema, example),
          t('Copy AI prompt'),
          status,
          true
        ),
        el(
          'details',
          {},
          el('summary', {}, t('Example JSON — all four question types')),
          el(
            'p',
            { class: 'muted' },
            t(
              'The image example references diagram.svg. Attach your own matching image when importing, or use a question type without images.'
            )
          ),
          copyBlock(
            t('Example JSON'),
            JSON.stringify(example, null, 2),
            t('Copy example JSON'),
            status
          ),
          button(
            t('Download example JSON'),
            () => download('question-bank-example.json', example),
            'subtle'
          )
        ),
        fieldReference(schema),
        el(
          'details',
          {},
          el('summary', {}, t('Full JSON Schema')),
          copyBlock(t('JSON Schema'), JSON.stringify(schema, null, 2), t('Copy schema'), status)
        ),
        button(t('Back to import'), () => document.querySelector('#modal').close(), 'primary')
      );
    } catch {
      content.replaceChildren(
        el(
          'p',
          { role: 'alert' },
          t('The format guide could not be loaded. Check your connection and try again.')
        ),
        button(t('Try again'), renderGuide, 'secondary')
      );
    }
  }
  void renderGuide();
}
