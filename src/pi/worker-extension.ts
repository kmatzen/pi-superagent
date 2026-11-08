import { workerRole } from './worker-role.ts'
import type { PiLike } from './extension.ts'

export default function superagentWorker(pi: PiLike): void {
  workerRole(pi as never, process.env)
}
