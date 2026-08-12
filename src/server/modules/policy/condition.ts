// Sandboxed allow-listed JSONLogic-subset evaluator (E017, FR-005/009; ADR-0014, AD-001/AD-007, HINT-001).
//
// SECURITY BOUNDARY: this is an IN-HOUSE evaluator. It NEVER uses `eval`, `Function`, `vm`, `require`, dynamic
// `import`, or any host/global/IO. The FIXED PURE operator allow-list (ALLOWED_OPERATORS) IS the boundary: a
// guarded condition is structured JSON whose only executable nodes are single-key objects keyed by an
// allow-listed operator (comparison, boolean logic, `var`/`has` allow-listed field access, bounded arithmetic,
// `in`/`if`). An unknown operator is REFUSED (`unsafe_operator`) — never silently ignored — and `var` refuses a
// prototype-polluting path (`__proto__`/`prototype`/`constructor`). There is NO time/random/network/custom
// operator: the ONLY time source is the injected decision timestamp (`opts.now`, exposed as the context var
// `now`), never `Date.now()` — so evaluation is DETERMINISTIC (FR-005): the same context yields the same result.
//
// RESOURCE BOUNDS (FR-009): every evaluation is bounded by the SAME caps the author-time lint (validate.ts)
// enforces — a serialized JSON SIZE cap, a node-count (complexity) budget, an AST recursion depth cap — plus an
// optional wall-clock timeout (a watchdog, injectable for tests — NOT a decision input). The size/depth/complexity
// caps are enforced identically on BOTH the author path (validate.ts, reject-before-persist) AND this eval path
// (defense-in-depth: a rule persisted before a cap tightened, or inserted out-of-band, still can never blow the
// signing path). A breach throws a `ConditionError`; the caller (evaluate.ts) treats any throw as a fail-closed
// skip (FR-010). An unguarded access to an ABSENT field throws (`missing_field`) so the rule fails closed; a
// `has()` guard (with short-circuiting `and`/`or`) lets an author safely probe an optional field (e.g. a usage
// aggregate).

/** A typed evaluator error; `code` distinguishes an unsafe operator, a bound breach, or a missing field. */
export class ConditionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConditionError";
  }
}

/**
 * The FIXED pure operator allow-list — THE security boundary. Any single-key object whose key is not in this
 * set is refused (`unsafe_operator`). Deliberately excludes every time/random/network/host/custom operator.
 */
export const ALLOWED_OPERATORS: ReadonlySet<string> = new Set([
  // comparison
  "==", "===", "!=", "!==", "<", "<=", ">", ">=",
  // boolean logic
  "and", "or", "!", "!!",
  // membership / conditional
  "in", "if",
  // allow-listed field access + has()-guard
  "var", "has",
  // bounded arithmetic
  "+", "-", "*", "/", "%", "min", "max",
]);

/** Path segments that could reach the prototype chain; `var`/`has` refuse them (no prototype pollution). */
const FORBIDDEN_PATH_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** Options bounding a single evaluation. Every bound is optional; a caller (evaluate.ts) passes the live config. */
export interface EvaluateConditionOptions {
  /** Wall-clock timeout (ms) for the evaluation watchdog; omit to disable the time bound. */
  timeoutMs?: number;
  /** Serialized-condition byte cap (defense-in-depth at eval; the SAME cap validate.ts enforces at author time). Omit to disable. */
  maxBytes?: number;
  /** Max AST recursion depth (operator nesting) before `max_depth_exceeded`. */
  maxDepth?: number;
  /** Max evaluated-node budget before `max_complexity_exceeded`. */
  maxComplexity?: number;
  /** The injected decision timestamp (epoch millis) — exposed as the context var `now`; the ONLY time source. */
  now?: number;
  /** Monotonic clock for the timeout watchdog (injectable for tests); defaults to `performance.now`. NOT a decision input. */
  monotonicNow?: () => number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_COMPLEXITY = 10_000;

interface EvalState {
  depth: number;
  ops: number;
  readonly maxDepth: number;
  readonly maxComplexity: number;
  readonly deadline: number | null;
  readonly clock: () => number;
}

/** JSONLogic-style truthiness: falsy for false/0/NaN/""/null/undefined and an EMPTY array; truthy otherwise. */
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

/** Coerce to a finite number for a comparison/arithmetic operand; non-numeric → NaN (a deterministic outcome). */
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return Number.NaN;
}

/** Normalize an operator argument into an array (a single non-array arg becomes a one-element list). */
function asArray(arg: unknown): unknown[] {
  return Array.isArray(arg) ? arg : [arg];
}

/**
 * Resolve a dot-separated `var` path against the read-only data, own-property only, refusing prototype keys.
 * A missing path throws `missing_field` UNLESS a default is supplied (a `has()`-guard alternative). Pure.
 */
function resolveVar(pathArg: unknown, data: Record<string, unknown>, state: EvalState): unknown {
  let path: unknown;
  let dflt: unknown;
  let hasDefault = false;
  if (Array.isArray(pathArg)) {
    path = pathArg[0];
    if (pathArg.length > 1) {
      hasDefault = true;
      dflt = evalNode(pathArg[1], data, state);
    }
  } else {
    path = pathArg;
  }
  if (typeof path !== "string" || path === "") {
    throw new ConditionError("invalid_condition", "`var` requires a non-empty string path");
  }
  const segments = path.split(".");
  let cursor: unknown = data;
  for (const seg of segments) {
    if (FORBIDDEN_PATH_KEYS.has(seg)) {
      throw new ConditionError("unsafe_operator", `forbidden field path segment: ${seg}`);
    }
    if (cursor === null || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, seg)) {
      if (hasDefault) return dflt;
      throw new ConditionError("missing_field", `unguarded access to absent field: ${path}`);
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/** `has(path)`: whether a dot-path resolves to an OWN property (never throws) — the safe optional-field probe. */
function hasVar(pathArg: unknown, data: Record<string, unknown>): boolean {
  const path = Array.isArray(pathArg) ? pathArg[0] : pathArg;
  if (typeof path !== "string" || path === "") return false;
  const segments = path.split(".");
  let cursor: unknown = data;
  for (const seg of segments) {
    if (FORBIDDEN_PATH_KEYS.has(seg)) return false;
    if (cursor === null || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, seg)) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return true;
}

/** A bounded arithmetic result must be finite; Infinity/NaN (e.g. divide-by-zero) is refused (`arithmetic_error`). */
function finiteOrThrow(n: number): number {
  if (!Number.isFinite(n)) throw new ConditionError("arithmetic_error", "non-finite arithmetic result");
  return n;
}

/** Apply a single allow-listed operator. `and`/`or`/`if` short-circuit (so a `has()`-guard protects a `var`). */
function applyOp(op: string, arg: unknown, data: Record<string, unknown>, state: EvalState): unknown {
  switch (op) {
    case "var":
      return resolveVar(arg, data, state);
    case "has":
      return hasVar(arg, data);
    case "and": {
      for (const node of asArray(arg)) {
        if (!truthy(evalNode(node, data, state))) return false;
      }
      return true;
    }
    case "or": {
      for (const node of asArray(arg)) {
        if (truthy(evalNode(node, data, state))) return true;
      }
      return false;
    }
    case "if": {
      const list = asArray(arg);
      let i = 0;
      for (; i + 1 < list.length; i += 2) {
        if (truthy(evalNode(list[i], data, state))) return evalNode(list[i + 1], data, state);
      }
      return i < list.length ? evalNode(list[i], data, state) : null;
    }
    case "!":
      return !truthy(evalNode(asArray(arg)[0], data, state));
    case "!!":
      return truthy(evalNode(asArray(arg)[0], data, state));
    default:
      return applyValueOp(op, asArray(arg).map((n) => evalNode(n, data, state)));
  }
}

/** Apply an operator whose operands are already (eagerly) evaluated: comparison, membership, arithmetic. */
function applyValueOp(op: string, args: unknown[]): unknown {
  const [a, b] = args;
  switch (op) {
    case "==":
    case "===":
      return a === b;
    case "!=":
    case "!==":
      return a !== b;
    case "<":
      return toNum(a) < toNum(b);
    case "<=":
      return toNum(a) <= toNum(b);
    case ">":
      return toNum(a) > toNum(b);
    case ">=":
      return toNum(a) >= toNum(b);
    case "in": {
      if (typeof b === "string") return typeof a === "string" && b.includes(a);
      if (Array.isArray(b)) return b.some((x) => x === a);
      return false;
    }
    case "+":
      return finiteOrThrow(args.reduce<number>((acc, x) => acc + toNum(x), 0));
    case "*":
      return finiteOrThrow(args.reduce<number>((acc, x) => acc * toNum(x), 1));
    case "-":
      return finiteOrThrow(args.length === 1 ? -toNum(a) : toNum(a) - toNum(b));
    case "/":
      return finiteOrThrow(toNum(a) / toNum(b));
    case "%":
      return finiteOrThrow(toNum(a) % toNum(b));
    case "min":
      return finiteOrThrow(Math.min(...args.map(toNum)));
    case "max":
      return finiteOrThrow(Math.max(...args.map(toNum)));
    default:
      // Unreachable: `op` was checked against ALLOWED_OPERATORS before dispatch.
      throw new ConditionError("unsafe_operator", `operator not allowed: ${op}`);
  }
}

/** Evaluate one condition node. Literals/arrays pass through; a single-key object is an allow-listed operator. */
function evalNode(node: unknown, data: Record<string, unknown>, state: EvalState): unknown {
  state.ops += 1;
  if (state.ops > state.maxComplexity) {
    throw new ConditionError("max_complexity_exceeded", "condition exceeded the complexity budget");
  }
  if (state.deadline !== null && state.clock() > state.deadline) {
    throw new ConditionError("timeout", "condition evaluation timed out");
  }
  if (node === null || typeof node !== "object") return node; // literal (string/number/boolean/null)
  if (Array.isArray(node)) return node.map((n) => evalNode(n, data, state));

  const keys = Object.keys(node);
  const op = keys[0];
  if (keys.length !== 1 || op === undefined) {
    throw new ConditionError("invalid_condition", "an operator node must be a single-key object");
  }
  if (!ALLOWED_OPERATORS.has(op)) {
    throw new ConditionError("unsafe_operator", `operator not allowed: ${op}`);
  }
  state.depth += 1;
  if (state.depth > state.maxDepth) {
    throw new ConditionError("max_depth_exceeded", "condition exceeded the maximum AST depth");
  }
  const result = applyOp(op, (node as Record<string, unknown>)[op], data, state);
  state.depth -= 1;
  return result;
}

/**
 * Evaluate a guarded condition against the read-only decision context and return whether it MATCHES (the
 * truthiness of the evaluated result). Deterministic: the ONLY time source is the injected `opts.now` (exposed
 * as the context var `now`); there is no wall-clock/random/network operator. Throws a `ConditionError` on an
 * unsafe operator, a resource-bound breach (size/depth/complexity/timeout), or an unguarded absent-field access —
 * the caller treats any throw as a fail-closed skip (FR-010). NEVER uses eval/Function/vm/host (FR-009).
 */
export function evaluateCondition(
  condition: unknown,
  context: Record<string, unknown>,
  opts: EvaluateConditionOptions = {},
): boolean {
  // Serialized-size bound (FR-009), enforced BEFORE any traversal — the SAME cap validate.ts applies at author
  // time, re-checked here as defense-in-depth so an over-size condition can never reach the walk on the eval path.
  if (opts.maxBytes != null) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(condition);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      throw new ConditionError("invalid_condition", "condition is not serializable JSON");
    }
    if (Buffer.byteLength(serialized, "utf8") > opts.maxBytes) {
      throw new ConditionError("max_size_exceeded", `condition exceeds ${opts.maxBytes} bytes`);
    }
  }
  const clock = opts.monotonicNow ?? (() => performance.now());
  const deadline = opts.timeoutMs != null ? clock() + opts.timeoutMs : null;
  const data: Record<string, unknown> =
    opts.now != null && !Object.prototype.hasOwnProperty.call(context, "now")
      ? { ...context, now: opts.now }
      : context;
  const state: EvalState = {
    depth: 0,
    ops: 0,
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxComplexity: opts.maxComplexity ?? DEFAULT_MAX_COMPLEXITY,
    deadline,
    clock,
  };
  return truthy(evalNode(condition, data, state));
}
