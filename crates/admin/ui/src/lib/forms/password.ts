// Random password for accounts created in the panel. No ambiguous characters
// (0/O, 1/l/I), so it can be read out or typed from the screen.

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_'

/** Uniform index in [0, n): discards bytes that would cause modulo bias. */
function uniform(n: number, random: () => number): number {
  const limit = 256 - (256 % n)
  for (;;) {
    const byte = random()
    if (byte < limit) return byte % n
  }
}

const cryptoByte = () => crypto.getRandomValues(new Uint8Array(1))[0]

/** 20 characters from 59 symbols ≈ 117 bits of entropy. */
export function generatePassword(length = 20, random: () => number = cryptoByte): string {
  return Array.from({ length }, () => ALPHABET[uniform(ALPHABET.length, random)]).join('')
}

/** What is wrong with a password; the panel shows it in the chosen language. */
export type PasswordProblem = 'tooShort' | 'tooLong'

/** Same rule as the server (nelcota_auth::validate_password), to warn before sending. */
export function passwordProblem(password: string): PasswordProblem | null {
  const length = [...password].length
  if (length < 8) return 'tooShort'
  if (length > 256) return 'tooLong'
  return null
}
