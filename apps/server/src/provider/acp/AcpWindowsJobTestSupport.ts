// FILE: AcpWindowsJobTestSupport.ts
// Purpose: Shared malformed executable fixtures for Windows ACP Job Object tests.
// Layer: Test support.

export function headerOnlyPortableExecutableFixture(): Buffer {
  const image = Buffer.alloc(0x400);
  const peOffset = 0x80;
  const optionalHeaderOffset = peOffset + 24;
  const sectionTableOffset = optionalHeaderOffset + 0xe0;
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(peOffset, 0x3c);
  image.writeUInt32LE(0x0000_4550, peOffset);
  image.writeUInt16LE(0x014c, peOffset + 4);
  image.writeUInt16LE(1, peOffset + 6);
  image.writeUInt16LE(0xe0, peOffset + 20);
  image.writeUInt16LE(0x0002, peOffset + 22);
  image.writeUInt16LE(0x010b, optionalHeaderOffset);
  image.writeUInt32LE(0x200, optionalHeaderOffset + 60);
  image.writeUInt32LE(0x200, sectionTableOffset + 16);
  image.writeUInt32LE(0x200, sectionTableOffset + 20);
  return image;
}
