import { useEffect, useState } from 'react'
import type { OperationState } from '../../shared/contracts'

export function OperationProgress({ operation }: { operation: OperationState }) {
  const [now, setNow] = useState(Date.now)
  const running = operation.status === 'running'
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, operation.id])

  const seconds = operation.startedAt
    ? Math.max(0, Math.floor((now - Date.parse(operation.startedAt)) / 1000))
    : 0
  const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  const stage = operation.stage ?? '等待操作'
  return (
    <>
      <progress aria-label={stage} max="100" value={operation.progress ?? (running ? undefined : 0)} />
      <span>
        {stage} · {operation.progress === null ? (running ? '等待设备完成' : '未完成') : `${operation.progress}%`}
        {running && ` · 本次操作已耗时 ${elapsed}`}
      </span>
      <small className="operation-progress-summary">{operation.summary}</small>
    </>
  )
}
