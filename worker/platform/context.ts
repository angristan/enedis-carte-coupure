import { Context, Effect, Layer } from "effect";
import type { NativeTraceContext } from "./trace.js";

export class BackgroundTasks extends Context.Service<BackgroundTasks, {
  readonly schedule: (task: Effect.Effect<void>) => Effect.Effect<void>;
}>()("BackgroundTasks") {}

export function backgroundTasksLayer(
  context: ExecutionContext,
  run: (task: Effect.Effect<void>) => Promise<void>,
) {
  return Layer.succeed(BackgroundTasks)({
    schedule: (task) => Effect.sync(() => context.waitUntil(run(task))),
  });
}

export class RequestContext extends Context.Service<RequestContext, {
  readonly trace: NativeTraceContext;
}>()("RequestContext") {}

export function requestContextLayer(context: ExecutionContext) {
  return Layer.succeed(RequestContext)({ trace: context });
}
