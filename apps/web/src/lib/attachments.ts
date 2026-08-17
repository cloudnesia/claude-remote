import {
  ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_PROMPT,
  type Attachment,
} from '@company/protocol'

/**
 * Lampiran di sisi browser SEBELUM dikirim — sama seperti `Attachment` di
 * protocol (byte base64 sudah di tangan), plus `id` lokal buat key `#each`
 * dan tombol hapus. `id` tidak pernah ikut ke wire.
 */
export type PendingAttachment = Attachment & { id: string }

export const dataUrlOf = (a: PendingAttachment): string => `data:${a.mime};base64,${a.dataBase64}`

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('gagal membaca file'))
    reader.onload = () => {
      // FileReader.readAsDataURL menghasilkan "data:<mime>;base64,<data>" —
      // yang kita mau kirim cuma bagian setelah koma.
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Baca sekumpulan `File` (dari picker, paste clipboard, atau drag-drop) jadi
 * lampiran siap kirim. Batas tipe/ukuran/jumlah diimpor dari protocol yang
 * sama dengan yang ditegakkan ulang di hub — supaya apa yang ditolak di sini
 * tidak pernah beda dengan apa yang ditolak di server.
 */
export async function filesToAttachments(
  files: Iterable<File>,
  existingCount: number,
): Promise<{ attachments: PendingAttachment[]; errors: string[] }> {
  const attachments: PendingAttachment[] = []
  const errors: string[] = []

  for (const file of files) {
    if (existingCount + attachments.length >= MAX_ATTACHMENTS_PER_PROMPT) {
      errors.push(`maksimal ${MAX_ATTACHMENTS_PER_PROMPT} lampiran per prompt`)
      break
    }
    if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
      errors.push(`${file.name}: tipe tidak didukung (${file.type || 'tidak dikenal'})`)
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name}: kelebihan ukuran (maks ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB)`)
      continue
    }
    try {
      const dataBase64 = await readAsBase64(file)
      attachments.push({
        id: crypto.randomUUID(),
        name: file.name || 'lampiran',
        mime: file.type,
        dataBase64,
      })
    } catch {
      errors.push(`${file.name}: gagal dibaca`)
    }
  }

  return { attachments, errors }
}
