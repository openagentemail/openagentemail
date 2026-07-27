import sanitizeHtml from 'sanitize-html';

export const MAX_EMAIL_HTML_LENGTH = 512 * 1024;

const ALLOWED_TAGS = [
  'p',
  'br',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
];

const NON_TEXT_TAGS = [
  'script',
  'style',
  'textarea',
  'option',
  'xmp',
  'noscript',
  'noembed',
  'noframes',
  'iframe',
  'object',
  'embed',
  'template',
  'svg',
  'math',
  'head',
  'title',
];

function tableCellTransform(
  tagName: string,
  attributes: Record<string, string>,
) {
  const numericAttributes: Record<string, string> = {};
  for (const name of ['colspan', 'rowspan']) {
    const value = attributes[name];
    if (value !== undefined && /^\d+$/.test(value)) {
      numericAttributes[name] = value;
    }
  }
  return { tagName, attribs: numericAttributes };
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },
  allowedSchemes: [],
  allowProtocolRelative: false,
  parseStyleAttributes: false,
  enforceHtmlBoundary: true,
  nonTextTags: NON_TEXT_TAGS,
  transformTags: {
    th: tableCellTransform,
    td: tableCellTransform,
  },
};

export type SanitizedEmailHtml =
  | { kind: 'ok'; html: string }
  | { kind: 'too_large' | 'failed'; html: '' };

export function sanitizeEmailHtml(
  html: unknown,
  sanitizer: (dirty: string, options: sanitizeHtml.IOptions) => string = sanitizeHtml,
): SanitizedEmailHtml {
  try {
    if (typeof html !== 'string') return { kind: 'failed', html: '' };
    if (html.length > MAX_EMAIL_HTML_LENGTH) {
      return { kind: 'too_large', html: '' };
    }
    return { kind: 'ok', html: sanitizer(html, OPTIONS) };
  } catch {
    return { kind: 'failed', html: '' };
  }
}
