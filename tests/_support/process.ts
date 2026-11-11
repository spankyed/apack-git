// Runs a process for a spec's own setup: a git that makes the repository a case is about.
import { execFile } from 'node:child_process'

export function run(file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; encoding?: BufferEncoding } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
}
