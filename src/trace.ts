// Git's own account of a command, read from its event stream (`GIT_TRACE2_EVENT`): which hooks it ran and how each
// ended. Git prints a hook's output and then only that the command failed; the stream says which hook it was and the
// code it exited with, so a refusal is said as the hook's. Asked of every command that may run a hook — a write or a
// command that reaches a remote — and of no read, which runs none.
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'path'
import * as fs from 'fs/promises'

/** A hook git ran for a command, and the code it exited with */
export interface HookRun { name: string; exitCode: number }

/** Where a command's events are written: a file of its own, read once it has exited and removed */
export const traceFile = (): string => path.join(os.tmpdir(), `apack-git-trace-${randomUUID()}.json`)

/** The hooks a command ran, in the order they started, from its event stream; none when there is none to read */
export async function hooksIn(file: string): Promise<HookRun[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  await fs.rm(file, { force: true })
  const started = new Map<number, string>()
  const ran: HookRun[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"child_')) continue
    let event: { event?: string; sid?: string; child_id?: number; child_class?: string; hook_name?: string; argv?: string[]; code?: number }
    try { event = JSON.parse(line) } catch { continue }
    // Only the command's own process: a git it started writes here too, under a session id that extends its
    // parent's with `/`, and the hook of a remote reached through a folder is that remote's, not this repository's
    if (event.sid?.includes('/')) continue
    if (event.event === 'child_start' && event.child_class === 'hook' && event.child_id !== undefined) {
      // Named by git from 2.36; before, by the program it ran, which is the hook's file
      started.set(event.child_id, event.hook_name ?? path.basename(event.argv?.[0] ?? 'hook'))
    } else if (event.event === 'child_exit' && event.child_id !== undefined && started.has(event.child_id)) {
      ran.push({ name: started.get(event.child_id)!, exitCode: event.code ?? 0 })
    }
  }
  return ran
}
