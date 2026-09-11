// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OperationState } from '../../shared/contracts'
import { OperationProgress } from './OperationProgress'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('无进度输出时持续显示耗时，结束后停止计时并呈现实际结果', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-11T05:00:00Z'))
  const operation: OperationState = {
    id: 'install', commandId: 'app.install', status: 'running', title: '安装 / 更新',
    summary: '等待设备接收完成，请保持连接。', suggestion: null, stage: '传输 APK',
    progress: null, startedAt: new Date().toISOString(), finishedAt: null,
    durationMs: null, recovery: null
  }
  const { rerender } = render(<OperationProgress operation={operation} />)
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
  expect(screen.queryByText(/12%/)).not.toBeInTheDocument()
  act(() => vi.advanceTimersByTime(67000))
  expect(screen.getByText(/已耗时 1 分 7 秒/)).toBeInTheDocument()
  rerender(<OperationProgress operation={{ ...operation, status: 'success', stage: '完成', progress: 100, summary: '安装成功，版本已验证。' }} />)
  expect(screen.getByText('安装成功，版本已验证。')).toBeInTheDocument()
  expect(screen.queryByText(/已耗时/)).not.toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
  rerender(<OperationProgress operation={{ ...operation, status: 'error', summary: '传输超时。' }} />)
  expect(screen.getByText('传输超时。')).toBeInTheDocument()
  expect(screen.queryByText(/等待设备完成/)).not.toBeInTheDocument()
})
