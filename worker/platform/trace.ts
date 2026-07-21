export interface TraceSpan {
  readonly isTraced?: boolean;
  setAttribute(key: string, value: string | number | boolean): void;
}

export interface NativeTraceContext {
  readonly tracing?: {
    enterSpan<T>(
      name: string,
      callback: (span: TraceSpan) => Promise<T>,
    ): Promise<T>;
  };
}

export type TraceAttributes = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export function tracedPromise<T>(
  context: NativeTraceContext | undefined,
  name: string,
  attributes: TraceAttributes,
  callback: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  const run = (span: TraceSpan): Promise<T> => {
    setAttributes(span, attributes);
    return callback(span);
  };
  return context?.tracing?.enterSpan
    ? context.tracing.enterSpan(name, run)
    : run(noopSpan);
}

export function setAttributes(
  span: TraceSpan,
  attributes: TraceAttributes,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) span.setAttribute(key, value);
  }
}

const noopSpan: TraceSpan = { isTraced: false, setAttribute() {} };
