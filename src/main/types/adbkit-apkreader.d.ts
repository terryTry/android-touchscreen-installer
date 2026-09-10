declare module '@devicefarmer/adbkit-apkreader' {
  interface NamedValue {
    name: string
  }

  interface IntentFilter {
    actions?: NamedValue[]
    categories?: NamedValue[]
  }

  interface ManifestActivity {
    name: string
    exported?: boolean
    targetActivity?: string
    intentFilters?: IntentFilter[]
  }

  interface UsesPermission {
    name: string
    maxSdkVersion?: number | string
  }

  interface DefinedPermission {
    name: string
    protectionLevel?: number | string
  }

  interface ApkManifest {
    package: string
    versionCode?: number
    versionName?: string
    usesSdk?: {
      minSdkVersion?: number
      targetSdkVersion?: number
    }
    usesPermissions?: UsesPermission[]
    permissions?: DefinedPermission[]
    application?: {
      name?: string
      label?: string
      icon?: string
      debuggable?: boolean
      activities?: ManifestActivity[]
      activityAliases?: ManifestActivity[]
    }
  }

  interface Reader {
    readManifest(): Promise<ApkManifest>
  }

  interface ApkReaderStatic {
    open(file: string): Promise<Reader>
  }

  const ApkReader: ApkReaderStatic
  export default ApkReader
}
