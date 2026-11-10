/**
 * One promise chain that runs tasks one after another, in the order asked.
 *
 * A task's failure is its caller's: the chain itself carries on, so one
 * refused write never blocks the next. The options store, the control
 * defaults and the MCP control each serialize through one of these.
 */
export function createSerial() {
  let tail = Promise.resolve()
  return function serial(task) {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
