export interface TraceSpan {
  isTraced?: boolean;
  setAttribute(key: string, value: string | number | boolean): void;
}

interface TraceContext {
  tracing?: {
    enterSpan<T>(name: string, callback: (span: TraceSpan) => Promise<T>): Promise<T>;
  };
}

type Attributes = Record<string, unknown>;

export function enterSpan<T>(
  ctx: TraceContext | null | undefined,
  name: string,
  attributes: Attributes,
  callback: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  const tracing = ctx?.tracing;
  const run = async (span?: TraceSpan) => {
    setAttributes(span, attributes);
    return callback(span || noopSpan);
  };

  if (tracing?.enterSpan) {
    return tracing.enterSpan(name, run);
  }
  return run(noopSpan);
}

export function setAttributes(span: TraceSpan | null | undefined, attributes: Attributes = {}): void {
  if (!span?.setAttribute) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      span.setAttribute(key, value);
    }
  }
}

const noopSpan: TraceSpan = {
  isTraced: false,
  setAttribute() {},
};
