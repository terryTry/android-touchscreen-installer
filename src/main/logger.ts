import log from 'electron-log/main'
import type { TechnicalLogEntry } from '../shared/contracts'

export function configureLogger(): void {
  log.initialize()
  log.transports.file.level = 'info'
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'warn'
}

export function writeTechnicalLog(entry: TechnicalLogEntry): void {
  log.info(JSON.stringify(entry))
}

export function writeApplicationError(error: unknown): void {
  log.error(error)
}
