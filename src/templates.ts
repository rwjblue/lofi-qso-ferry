import { normalizeAdifValue, type AdifRecord } from "./adif.ts";
/**
 * Bounded, interpreted Liquid subset. Compatible helper semantics were reviewed
 * against HaLo's MIT SDK (Sebastian Delmont, 2026); implementation is independent.
 * Profile changes require a new immutable template version, never historical work.
 */
export const TEMPLATE_PROFILE = "ferry-liquid-v1";
export const POTA_TEMPLATE =
  '{% assign parks = op.refs | where: "type", "potaActivation" | map: "ref" %}{% if parks.size > 0 %}POTA {{ parks | sentence }}{% endif %}';
export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | TemplateValue[]
  | { [key: string]: TemplateValue };
export interface TemplateVersion {
  id: string;
  profile: typeof TEMPLATE_PROFILE;
  fields: Partial<Record<"COMMENT" | "NOTES" | "QSLMSG", string>>;
  fallbackNotes: boolean;
}
export class TemplateError extends Error {}
type Node =
  | { kind: "text" | "output" | "assign"; text: string }
  | { kind: "if"; expression: string; yes: Node[]; no: Node[] }
  | { kind: "for"; name: string; expression: string; body: Node[] };
interface Budget {
  steps: number;
  iterations: number;
  allocated: number;
}
const LIMITS = {
  source: 16384,
  output: 8192,
  intermediate: 65536,
  steps: 20000,
  iterations: 1000,
  depth: 16,
  nodes: 2048,
};
function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
function charge(budget: Budget, amount = 1): void {
  budget.steps += amount;
  if (budget.steps > LIMITS.steps)
    throw new TemplateError("Template step limit exceeded");
}
function allocate(budget: Budget, value: TemplateValue): TemplateValue {
  const size =
    typeof value === "string"
      ? bytes(value)
      : Array.isArray(value)
        ? value.length * 16
        : 16;
  budget.allocated += size;
  if (budget.allocated > LIMITS.intermediate)
    throw new TemplateError("Template intermediate allocation limit exceeded");
  return value;
}
function tokenize(source: string): string[] {
  if (bytes(source) > LIMITS.source)
    throw new TemplateError("Template source exceeds 16 KiB");
  const tokens = source.split(/({{[\s\S]*?}}|{%[\s\S]*?%})/).filter(Boolean);
  if (tokens.length > LIMITS.nodes)
    throw new TemplateError("Template structural limit exceeded");
  return tokens;
}
function parse(source: string): Node[] {
  const tokens = tokenize(source);
  let index = 0;
  function body(
    depth: number,
    stops: string[] = [],
  ): { nodes: Node[]; stop: string } {
    if (depth > LIMITS.depth)
      throw new TemplateError("Template nesting limit exceeded");
    const nodes: Node[] = [];
    while (index < tokens.length) {
      const raw = tokens[index++]!;
      if (raw.startsWith("{{")) {
        nodes.push({ kind: "output", text: raw.slice(2, -2).trim() });
        continue;
      }
      if (!raw.startsWith("{%")) {
        if (raw.includes("{{") || raw.includes("{%"))
          throw new TemplateError("Unclosed template token");
        nodes.push({ kind: "text", text: raw });
        continue;
      }
      const tag = raw.slice(2, -2).trim();
      const name = tag.split(/\s/)[0]!;
      if (stops.includes(name)) return { nodes, stop: tag };
      if (name === "assign") {
        if (!/^assign\s+[A-Za-z_]\w*\s*=\s*.+$/.test(tag))
          throw new TemplateError("Invalid assign");
        nodes.push({ kind: "assign", text: tag.slice(7).trim() });
      } else if (name === "if" || name === "unless") {
        const expression = tag.slice(name.length).trim();
        let yes = body(depth + 1, ["else", "elsif", "endif", "endunless"]);
        const no: Node[] = [];
        if (yes.stop.startsWith("elsif"))
          throw new TemplateError(
            "Use nested if/else in ferry-liquid-v1; elsif is unsupported",
          );
        if (yes.stop === "else") {
          const alternate = body(depth + 1, ["endif", "endunless"]);
          no.push(...alternate.nodes);
          yes = { nodes: yes.nodes, stop: alternate.stop };
        }
        if (yes.stop !== (name === "if" ? "endif" : "endunless"))
          throw new TemplateError("Unclosed conditional");
        nodes.push({
          kind: "if",
          expression: name === "unless" ? `!${expression}` : expression,
          yes: yes.nodes,
          no,
        });
      } else if (name === "for") {
        const match = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+)$/.exec(tag);
        if (!match) throw new TemplateError("Invalid for loop");
        const loop = body(depth + 1, ["endfor"]);
        if (loop.stop !== "endfor")
          throw new TemplateError("Unclosed for loop");
        nodes.push({
          kind: "for",
          name: match[1]!,
          expression: match[2]!,
          body: loop.nodes,
        });
      } else if (name === "comment") {
        let closed = false;
        while (index < tokens.length)
          if (tokens[index++]!.trim() === "{% endcomment %}") {
            closed = true;
            break;
          }
        if (!closed) throw new TemplateError("Unclosed comment");
      } else throw new TemplateError(`Unsupported Liquid tag: ${name}`);
    }
    return { nodes, stop: "" };
  }
  return body(0).nodes;
}
/** Split only outside quotes; expressions never evaluate JavaScript. */
function splitExpression(input: string, separator: string): string[] {
  const parts: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (input.startsWith(separator, i)) {
      parts.push(input.slice(start, i).trim());
      i += separator.length - 1;
      start = i + 1;
    }
  }
  if (quote) throw new TemplateError("Unclosed expression string");
  parts.push(input.slice(start).trim());
  return parts;
}
function property(
  value: TemplateValue | undefined,
  key: string,
): TemplateValue {
  if (["__proto__", "constructor", "prototype"].includes(key))
    throw new TemplateError("Unsafe template property");
  if (key === "size")
    return typeof value === "string" || Array.isArray(value) ? value.length : 0;
  if (Array.isArray(value))
    return /^\d+$/.test(key) ? (value[Number(key)] ?? null) : null;
  return value && typeof value === "object" && Object.hasOwn(value, key)
    ? (value[key] ?? null)
    : null;
}
function scalar(
  expression: string,
  scope: Record<string, TemplateValue>,
  budget: Budget,
): TemplateValue {
  charge(budget);
  if (/^(['"])[\s\S]*\1$/.test(expression)) return expression.slice(1, -1);
  if (expression === "true") return true;
  if (expression === "false") return false;
  if (expression === "nil" || expression === "null") return null;
  if (expression === "blank" || expression === "empty") return "";
  if (/^-?\d+(\.\d+)?$/.test(expression)) return Number(expression);
  const range = /^\((\d+)\.\.(\d+)\)$/.exec(expression);
  if (range) {
    const first = Number(range[1]);
    const last = Number(range[2]);
    const count = Math.max(0, last - first + 1);
    if (count > LIMITS.iterations)
      throw new TemplateError("Template range limit exceeded");
    return allocate(
      budget,
      Array.from({ length: count }, (_, i) => first + i),
    );
  }
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z0-9_]\w*)*$/.test(expression))
    throw new TemplateError(`Unsupported template expression: ${expression}`);
  const path = expression.split(".");
  let value: TemplateValue = property(scope, path[0]!);
  for (const part of path.slice(1)) value = property(value, part);
  return value;
}
function text(value: TemplateValue | undefined): string {
  return value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? Array.isArray(value)
        ? value.map((v) => text(v)).join("")
        : ""
      : String(value);
}
function truthy(value: TemplateValue): boolean {
  return value !== false && value !== null;
}
function blank(value: TemplateValue): boolean {
  return (
    value === null ||
    value === false ||
    (typeof value === "string" && !value.trim()) ||
    (Array.isArray(value) && !value.length)
  );
}
function filter(
  name: string,
  value: TemplateValue,
  args: TemplateValue[],
  budget: Budget,
): TemplateValue {
  charge(budget, Array.isArray(value) ? value.length + 1 : 1);
  const list = Array.isArray(value) ? value : [];
  const arg = (i: number, fallback = "") =>
    args[i] === undefined ? fallback : text(args[i]);
  const boundedJoin = (parts: string[], separator: string): string => {
    const size =
      parts.reduce((sum, part) => sum + bytes(part), 0) +
      bytes(separator) * Math.max(0, parts.length - 1);
    if (size + budget.allocated > LIMITS.intermediate)
      throw new TemplateError(
        "Template intermediate allocation limit exceeded",
      );
    return parts.join(separator);
  };
  let result: TemplateValue;
  switch (name) {
    case "where":
      result = list.filter(
        (item) => property(item, arg(0)) === (args[1] ?? true),
      );
      break;
    case "map":
      result = list.map((item) => property(item, arg(0)));
      break;
    case "compact":
      result = list.filter((item) => item !== null);
      break;
    case "uniq":
      result = [
        ...new Set(
          list.map((item) => (typeof item === "object" ? text(item) : item)),
        ),
      ];
      break;
    case "join":
      result = boundedJoin(
        list.map((item) => text(item)),
        arg(0, " "),
      );
      break;
    case "sentence": {
      const parts = list.map((item) => text(item).trim()).filter(Boolean);
      result =
        parts.length < 2
          ? parts.join("")
          : boundedJoin(
              [boundedJoin(parts.slice(0, -1), arg(0, ", ")), parts.at(-1)!],
              arg(1, " & "),
            );
      break;
    }
    case "refLabels":
      result = list
        .map(
          (item) =>
            ["shortLabel", "label", "ref"]
              .map((key) => text(property(item, key)).trim())
              .find(Boolean) ?? "",
        )
        .filter(Boolean);
      break;
    case "default":
      result = blank(value) ? (args[0] ?? "") : value;
      break;
    case "size":
      result =
        typeof value === "string" || Array.isArray(value) ? value.length : 0;
      break;
    case "first":
      result = list[0] ?? null;
      break;
    case "last":
      result = list.at(-1) ?? null;
      break;
    case "upcase":
      result = text(value).toUpperCase();
      break;
    case "downcase":
      result = text(value).toLowerCase();
      break;
    case "strip":
      result = text(value).trim();
      break;
    case "strip_newlines":
      result = text(value).replace(/[\r\n]/g, "");
      break;
    case "oneLine":
      result = text(value).replace(/\s+/g, " ").trim();
      break;
    case "dash":
      result = text(value)
        .replace(/[^A-Za-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      break;
    case "alnum":
      result = text(value).replace(/[^A-Za-z0-9]/g, "");
      break;
    case "append":
      result = boundedJoin([text(value), arg(0)], "");
      break;
    case "prepend":
      result = boundedJoin([arg(0), text(value)], "");
      break;
    case "split":
      if (!arg(0))
        throw new TemplateError("Empty split delimiter is unsupported");
      result = text(value).split(arg(0), 1001);
      break;
    case "replace":
      if (!arg(0))
        throw new TemplateError("Empty replace search is unsupported");
      {
        const parts = text(value).split(arg(0), 1001);
        if (parts.length > 1000)
          throw new TemplateError("Replacement iteration limit exceeded");
        result = boundedJoin(parts, arg(1));
      }
      break;
    case "pad": {
      const width = Number(args[0] ?? 3);
      if (!Number.isInteger(width) || width < 0 || width > 128)
        throw new TemplateError("Padding width must be 0–128");
      result = text(value).trim()
        ? text(value).trim().padStart(width, "0")
        : "";
      break;
    }
    case "cut": {
      const digits: Record<string, string> = {
        "0": "T",
        "1": "A",
        "5": "E",
        "9": "N",
      };
      result = text(value).replace(/[0159]/g, (digit) =>
        arg(0, "09").includes(digit) ? digits[digit]! : digit,
      );
      break;
    }
    case "truncate": {
      const count = Number(args[0] ?? 50);
      if (!Number.isInteger(count) || count < 0 || count > 8192)
        throw new TemplateError("Invalid truncate length");
      const tail = arg(1, "...");
      result =
        text(value).length > count
          ? text(value).slice(0, Math.max(0, count - tail.length)) +
            tail.slice(0, count)
          : text(value);
      break;
    }
    case "date": {
      const date = new Date(text(value));
      if (!Number.isFinite(date.getTime())) {
        result = text(value);
        break;
      }
      const iso = date.toISOString();
      const formats: Record<string, string> = {
        Y: iso.slice(0, 4),
        m: iso.slice(5, 7),
        d: iso.slice(8, 10),
        H: iso.slice(11, 13),
        M: iso.slice(14, 16),
        S: iso.slice(17, 19),
        F: iso.slice(0, 10),
        T: iso.slice(11, 19),
        "%": "%",
      };
      result = arg(0, "%Y-%m-%d").replace(/%([A-Za-z%])/g, (_, key: string) => {
        if (formats[key] === undefined)
          throw new TemplateError(`Unsupported UTC date directive %${key}`);
        return formats[key]!;
      });
      break;
    }
    default:
      throw new TemplateError(`Unsupported Liquid filter: ${name}`);
  }
  if (Array.isArray(result) && result.length > LIMITS.iterations)
    throw new TemplateError("Template array limit exceeded");
  return allocate(budget, result);
}
function evaluate(
  expression: string,
  scope: Record<string, TemplateValue>,
  budget: Budget,
): TemplateValue {
  const parts = splitExpression(expression, "|");
  let value = scalar(parts[0]!, scope, budget);
  for (const part of parts.slice(1)) {
    const sections = splitExpression(part, ":");
    if (sections.length > 2)
      throw new TemplateError("Invalid filter arguments");
    const args = sections[1]
      ? splitExpression(sections[1], ",").map((item) =>
          scalar(item, scope, budget),
        )
      : [];
    value = filter(sections[0]!, value, args, budget);
  }
  return value;
}
function condition(
  expression: string,
  scope: Record<string, TemplateValue>,
  budget: Budget,
): boolean {
  charge(budget);
  if (expression.startsWith("!")) {
    if (expression.startsWith("!!"))
      throw new TemplateError("Invalid condition");
    return !condition(expression.slice(1), scope, budget);
  }
  const ors = splitExpression(expression, " or ");
  if (ors.length > 1) return ors.some((part) => condition(part, scope, budget));
  const ands = splitExpression(expression, " and ");
  if (ands.length > 1)
    return ands.every((part) => condition(part, scope, budget));
  for (const operator of [
    " contains ",
    " == ",
    " != ",
    " >= ",
    " <= ",
    " > ",
    " < ",
  ]) {
    const parts = splitExpression(expression, operator);
    if (parts.length === 1) continue;
    if (parts.length !== 2) throw new TemplateError("Invalid comparison");
    const left = evaluate(parts[0]!, scope, budget);
    const right = evaluate(parts[1]!, scope, budget);
    if (operator === " contains ")
      return typeof left === "string"
        ? left.includes(text(right))
        : Array.isArray(left) && left.includes(right);
    const equality = ["blank", "empty"].includes(parts[1]!)
      ? blank(left)
      : left === right;
    if (operator === " == ") return equality;
    if (operator === " != ") return !equality;
    if (typeof left !== "number" || typeof right !== "number") return false;
    if (operator === " >= ") return left >= right;
    if (operator === " <= ") return left <= right;
    if (operator === " > ") return left > right;
    return left < right;
  }
  return truthy(evaluate(expression, scope, budget));
}
function validateContext(
  value: TemplateValue,
  budget: Budget,
  depth = 0,
): void {
  if (depth > LIMITS.depth)
    throw new TemplateError("Template context nesting limit exceeded");
  charge(budget);
  allocate(budget, value);
  if (Array.isArray(value)) {
    if (value.length > 1000)
      throw new TemplateError("Template context array limit exceeded");
    for (const item of value) validateContext(item, budget, depth + 1);
  } else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new TemplateError("Unsafe template context");
      validateContext(item, budget, depth + 1);
    }
}
export function renderTemplate(
  source: string,
  context: Record<string, TemplateValue>,
): string {
  const nodes = parse(source);
  const budget: Budget = { steps: 0, iterations: 0, allocated: 0 };
  validateContext(context, budget);
  const scope: Record<string, TemplateValue> = Object.assign(
    Object.create(null),
    context,
  );
  let output = "";
  const append = (value: string) => {
    if (bytes(output) + bytes(value) > LIMITS.output)
      throw new TemplateError("Rendered template exceeds 8 KiB");
    output += value;
  };
  function execute(body: Node[]): void {
    for (const node of body) {
      charge(budget);
      if (node.kind === "text") append(node.text);
      else if (node.kind === "output")
        append(text(evaluate(node.text, scope, budget)));
      else if (node.kind === "assign") {
        const at = node.text.indexOf("=");
        const name = node.text.slice(0, at).trim();
        if (["__proto__", "constructor", "prototype"].includes(name))
          throw new TemplateError("Unsafe assignment");
        scope[name] = evaluate(node.text.slice(at + 1).trim(), scope, budget);
      } else if (node.kind === "if")
        execute(condition(node.expression, scope, budget) ? node.yes : node.no);
      else if (node.kind === "for") {
        const values = evaluate(node.expression, scope, budget);
        if (!Array.isArray(values)) continue;
        const oldValue = scope[node.name];
        const oldLoop = scope.forloop;
        for (let i = 0; i < values.length; i++) {
          if (++budget.iterations > LIMITS.iterations)
            throw new TemplateError("Aggregate loop iteration limit exceeded");
          scope[node.name] = values[i]!;
          scope.forloop = {
            index: i + 1,
            index0: i,
            first: i === 0,
            last: i === values.length - 1,
            length: values.length,
          };
          execute(node.body);
        }
        if (oldValue === undefined) delete scope[node.name];
        else scope[node.name] = oldValue;
        if (oldLoop === undefined) delete scope.forloop;
        else scope.forloop = oldLoop;
      }
    }
  }
  execute(nodes);
  return output;
}
export function validateTemplateVersion(value: TemplateVersion): void {
  if (value.profile !== TEMPLATE_PROFILE)
    throw new TemplateError("Unsupported template compatibility profile");
  let total = 0;
  for (const [field, source] of Object.entries(value.fields)) {
    if (
      !["COMMENT", "NOTES", "QSLMSG"].includes(field) ||
      typeof source !== "string"
    )
      throw new TemplateError("Templates may only change narrative fields");
    total += bytes(source);
    parse(source);
  }
  if (total > LIMITS.source)
    throw new TemplateError("Combined template source exceeds 16 KiB");
}
export function renderNarrative(
  version: TemplateVersion,
  context: Record<string, TemplateValue>,
): AdifRecord {
  validateTemplateVersion(version);
  const output: AdifRecord = Object.create(null);
  for (const [field, source] of Object.entries(version.fields)) {
    const value = normalizeAdifValue(field, renderTemplate(source, context));
    if (bytes(value) > LIMITS.output)
      throw new TemplateError("Normalized narrative exceeds 8 KiB");
    output[field] = value;
  }
  if (version.fallbackNotes && !Object.hasOwn(output, "NOTES")) {
    const notes = normalizeAdifValue(
      "NOTES",
      text(property(context.qso, "notes")),
    );
    if (bytes(notes) > LIMITS.output)
      throw new TemplateError("Fallback notes exceed 8 KiB");
    output.NOTES = notes;
  }
  return output;
}
