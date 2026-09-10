import type { OperationRecovery } from '../shared/contracts'

export class AppError extends Error {
  readonly suggestion: string
  readonly recovery: OperationRecovery | null

  constructor(message: string, suggestion: string, recovery: OperationRecovery | null = null) {
    super(message)
    this.name = 'AppError'
    this.suggestion = suggestion
    this.recovery = recovery
  }
}
