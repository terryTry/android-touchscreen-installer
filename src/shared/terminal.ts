export interface TerminalRequest {
  id: string
  command: string
  serial: string | null
  cols: number
  rows: number
}

export type TerminalEvent =
  | { id: string; type: 'started'; mode: 'command' | 'shell'; serial: string | null }
  | { id: string; type: 'output'; data: string }
  | { id: string; type: 'exit'; code: number | null; stopped: boolean; message: string }

export interface TerminalApi {
  copyTerminalText: (text: string) => Promise<void>
  readTerminalClipboard: () => Promise<string>
  startTerminal: (request: TerminalRequest) => Promise<void>
  writeTerminal: (id: string, data: string) => Promise<void>
  stopTerminal: (id: string) => Promise<void>
  acknowledgeTerminal: (id: string, length: number) => Promise<void>
  onTerminal: (listener: (event: TerminalEvent) => void) => () => void
}
