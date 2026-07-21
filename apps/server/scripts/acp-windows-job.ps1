param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSourceHash,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2

function Write-AcpJobCompilerError([string]$Message, [int]$ExitCode = 70) {
  [Console]::Error.WriteLine("SYNARA_ACP_JOB_COMPILER_ERROR " + $Message)
  [Console]::Error.Flush()
  [Environment]::Exit($ExitCode)
}

function Test-PositivePowerOfTwo([uint32]$Value) {
  return $Value -gt 0 -and ($Value -band ($Value - 1)) -eq 0
}

function Test-AcpJobExecutable([string]$Path) {
  if (![IO.File]::Exists($Path)) {
    return $false
  }
  try {
    $image = [IO.File]::ReadAllBytes($Path)
    if ($image.Length -lt 1024 -or $image[0] -ne 0x4d -or $image[1] -ne 0x5a) {
      return $false
    }
    $peOffset = [BitConverter]::ToInt32($image, 0x3c)
    if (
      $peOffset -lt 64 -or
      $peOffset -gt $image.Length - 24 -or
      [BitConverter]::ToUInt32($image, $peOffset) -ne 0x00004550
    ) {
      return $false
    }

    $machine = [BitConverter]::ToUInt16($image, $peOffset + 4)
    $sectionCount = [BitConverter]::ToUInt16($image, $peOffset + 6)
    $optionalHeaderSize = [BitConverter]::ToUInt16($image, $peOffset + 20)
    $characteristics = [BitConverter]::ToUInt16($image, $peOffset + 22)
    if (
      $machine -notin @(0x014c, 0x8664, 0xaa64) -or
      $sectionCount -lt 1 -or
      $sectionCount -gt 96 -or
      ($characteristics -band 0x0002) -eq 0
    ) {
      return $false
    }

    $optionalHeaderOffset = $peOffset + 24
    $optionalHeaderMagic = [BitConverter]::ToUInt16($image, $optionalHeaderOffset)
    $minimumOptionalHeaderSize = if ($optionalHeaderMagic -eq 0x010b) {
      0x00e0
    } elseif ($optionalHeaderMagic -eq 0x020b) {
      0x00f0
    } else {
      0
    }
    if ($minimumOptionalHeaderSize -eq 0 -or $optionalHeaderSize -lt $minimumOptionalHeaderSize) {
      return $false
    }

    $addressOfEntryPoint = [BitConverter]::ToUInt32($image, $optionalHeaderOffset + 16)
    $sectionAlignment = [BitConverter]::ToUInt32($image, $optionalHeaderOffset + 32)
    $fileAlignment = [BitConverter]::ToUInt32($image, $optionalHeaderOffset + 36)
    $sizeOfImage = [BitConverter]::ToUInt32($image, $optionalHeaderOffset + 56)
    $sectionTableOffset = $optionalHeaderOffset + $optionalHeaderSize
    $sectionTableEnd = $sectionTableOffset + ($sectionCount * 40)
    if ($sectionTableEnd -gt $image.Length) {
      return $false
    }
    $sizeOfHeaders = [BitConverter]::ToUInt32($image, $optionalHeaderOffset + 60)
    $subsystem = [BitConverter]::ToUInt16($image, $optionalHeaderOffset + 68)
    $dataDirectoryOffset = if ($optionalHeaderMagic -eq 0x010b) { 92 } else { 108 }
    $numberOfDataDirectories = [BitConverter]::ToUInt32(
      $image,
      $optionalHeaderOffset + $dataDirectoryOffset
    )
    if (
      $addressOfEntryPoint -eq 0 -or
      !(Test-PositivePowerOfTwo $fileAlignment) -or
      $fileAlignment -lt 0x0200 -or
      $fileAlignment -gt 0x10000 -or
      !(Test-PositivePowerOfTwo $sectionAlignment) -or
      $sectionAlignment -lt $fileAlignment -or
      $sizeOfImage -eq 0 -or
      $sizeOfImage % $sectionAlignment -ne 0 -or
      $sizeOfHeaders -lt $sectionTableEnd -or
      $sizeOfHeaders -gt $image.Length -or
      $sizeOfHeaders % $fileAlignment -ne 0 -or
      $subsystem -notin @(2, 3) -or
      $numberOfDataDirectories -lt 1 -or
      $numberOfDataDirectories -gt 16
    ) {
      return $false
    }

    $hasRawData = $false
    $entryPointInExecutableCode = $false
    for ($index = 0; $index -lt $sectionCount; $index += 1) {
      $sectionOffset = $sectionTableOffset + ($index * 40)
      $virtualSize = [BitConverter]::ToUInt32($image, $sectionOffset + 8)
      $virtualAddress = [BitConverter]::ToUInt32($image, $sectionOffset + 12)
      $rawDataSize = [BitConverter]::ToUInt32($image, $sectionOffset + 16)
      $rawDataOffset = [BitConverter]::ToUInt32($image, $sectionOffset + 20)
      $sectionCharacteristics = [BitConverter]::ToUInt32($image, $sectionOffset + 36)
      $virtualSpan = [Math]::Max([uint64]$virtualSize, [uint64]$rawDataSize)
      if (
        $virtualSpan -eq 0 -or
        $virtualAddress -lt $sectionAlignment -or
        $virtualAddress % $sectionAlignment -ne 0 -or
        ([uint64]$virtualAddress + $virtualSpan) -gt [uint64]$sizeOfImage
      ) {
        return $false
      }
      if ($rawDataSize -gt 0) {
        if (
          $rawDataOffset -lt $sizeOfHeaders -or
          $rawDataOffset % $fileAlignment -ne 0 -or
          $rawDataSize % $fileAlignment -ne 0 -or
          ([uint64]$rawDataOffset + [uint64]$rawDataSize) -gt [uint64]$image.Length
        ) {
          return $false
        }
        $hasRawData = $true
      }
      if (
        $addressOfEntryPoint -ge $virtualAddress -and
        [uint64]$addressOfEntryPoint -lt ([uint64]$virtualAddress + $virtualSpan) -and
        ($sectionCharacteristics -band 0x00000020) -ne 0 -and
        ($sectionCharacteristics -band 0x20000000) -ne 0
      ) {
        $entryPointInExecutableCode = $true
      }
    }
    return $hasRawData -and $entryPointInExecutableCode
  } catch {
    return $false
  }
}

try {
  $sourcePath = [IO.Path]::Combine($PSScriptRoot, "acp-windows-job-native.cs")
  if (
    ![IO.File]::Exists($sourcePath) -or
    [string]::IsNullOrWhiteSpace($ExpectedSourceHash) -or
    $ExpectedSourceHash -notmatch "^[0-9a-f]{64}$" -or
    ![IO.Path]::IsPathRooted($OutputPath) -or
    $OutputPath -match "[`0`r`n]" -or
    [IO.Path]::GetExtension($OutputPath) -ne ".exe"
  ) {
    throw "unsafe compiler input"
  }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $actualSourceHash = ([BitConverter]::ToString(
      $sha256.ComputeHash([IO.File]::ReadAllBytes($sourcePath))
    )).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  if ($actualSourceHash -ne $ExpectedSourceHash) {
    throw "native source hash mismatch"
  }

  $mutexName = "Local\SynaraAcpJobCompile-" + $ExpectedSourceHash
  $mutex = [Threading.Mutex]::new($false, $mutexName)
  $lockTaken = $false
  try {
    $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
    if (!$lockTaken) {
      throw "timed out waiting for the ACP Job Object helper compiler"
    }
    if (!(Test-AcpJobExecutable $OutputPath)) {
      $candidatePath = $OutputPath + "." + [Guid]::NewGuid().ToString("N") + ".exe"
      try {
        Add-Type -Path $sourcePath -OutputAssembly $candidatePath -OutputType ConsoleApplication
        Move-Item -LiteralPath $candidatePath -Destination $OutputPath -Force
      } finally {
        if ([IO.File]::Exists($candidatePath)) {
          Remove-Item -LiteralPath $candidatePath -Force
        }
      }
    }
  } finally {
    if ($lockTaken) {
      [void]$mutex.ReleaseMutex()
    }
    $mutex.Dispose()
  }
} catch {
  Write-AcpJobCompilerError $_.Exception.Message
}
