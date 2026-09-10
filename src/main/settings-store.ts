import ElectronStore from 'electron-store'
import type {
  OperationHistoryDetail,
  SystemDeploymentRecord
} from '../shared/contracts'

interface StoredSettings {
  recentTcp: {
    host: string
    port: number
  }
  originalLaunchers: Record<string, string>
  managedPackages: Record<string, string>
  systemDeployments: Record<string, SystemDeploymentRecord>
  operationHistory: OperationHistoryDetail[]
}

export interface SettingsGateway {
  getRecentTcp(): StoredSettings['recentTcp']
  setRecentTcp(host: string, port: number): void
  getOriginalLauncher(serial: string, userId?: number): string | null
  saveOriginalLauncher(serial: string, component: string, userId?: number): void
  getManagedPackage(serial: string, userId?: number): string | null
  saveManagedPackage(serial: string, packageName: string, userId?: number): void
  getSystemDeployment(serial: string, packageName: string): SystemDeploymentRecord | null
  saveSystemDeployment(record: SystemDeploymentRecord): void
  removeSystemDeployment(serial: string, packageName: string): void
  getOperationHistory(): OperationHistoryDetail[]
  saveOperationHistory(history: OperationHistoryDetail[]): void
}

export class SettingsStore implements SettingsGateway {
  private readonly store = new ElectronStore<StoredSettings>({
    name: 'settings',
    defaults: {
      recentTcp: {
        host: '',
        port: 5555
      },
      originalLaunchers: {},
      managedPackages: {},
      systemDeployments: {},
      operationHistory: []
    }
  })

  getRecentTcp(): StoredSettings['recentTcp'] {
    return this.store.get('recentTcp')
  }

  setRecentTcp(host: string, port: number): void {
    this.store.set('recentTcp', { host, port })
  }

  getOriginalLauncher(serial: string, userId = 0): string | null {
    return this.store.get('originalLaunchers')[`${serial}::${userId}`] ?? null
  }

  saveOriginalLauncher(serial: string, component: string, userId = 0): void {
    const launchers = this.store.get('originalLaunchers')
    const key = `${serial}::${userId}`
    if (launchers[key]) return
    this.store.set('originalLaunchers', {
      ...launchers,
      [key]: component
    })
  }

  getManagedPackage(serial: string, userId = 0): string | null {
    return this.store.get('managedPackages')[`${serial}::${userId}`] ?? null
  }

  saveManagedPackage(serial: string, packageName: string, userId = 0): void {
    this.store.set('managedPackages', {
      ...this.store.get('managedPackages'),
      [`${serial}::${userId}`]: packageName
    })
  }

  getSystemDeployment(
    serial: string,
    packageName: string
  ): SystemDeploymentRecord | null {
    return this.store.get('systemDeployments')[`${serial}::${packageName}`] ?? null
  }

  saveSystemDeployment(record: SystemDeploymentRecord): void {
    this.store.set('systemDeployments', {
      ...this.store.get('systemDeployments'),
      [`${record.serial}::${record.packageName}`]: record
    })
  }

  removeSystemDeployment(serial: string, packageName: string): void {
    const deployments = { ...this.store.get('systemDeployments') }
    delete deployments[`${serial}::${packageName}`]
    this.store.set('systemDeployments', deployments)
  }

  getOperationHistory(): OperationHistoryDetail[] {
    return this.store.get('operationHistory')
  }

  saveOperationHistory(history: OperationHistoryDetail[]): void {
    this.store.set('operationHistory', history)
  }

}
