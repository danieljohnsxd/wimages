/**
 * A value the types forbid, passed the way an untyped JS caller can. Tests use
 * it to reach the runtime option validation; `T` comes from the call site.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is inferred from the call site's expected type; that is the point
export function untyped<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately bypasses the types to exercise runtime validation
  return value as T;
}
