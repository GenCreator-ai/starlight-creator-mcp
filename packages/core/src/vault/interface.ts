export interface SecretVault {
  readonly backend: string
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  list(): Promise<string[]>
}

export const SECRET_NAMES = {
  openrouter: 'OPENROUTER_API_KEY',
  muapi: 'MUAPI_KEY',
  fal: 'FAL_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  gemini: 'GEMINI_API_KEY',
  postiz: 'POSTIZ_API_KEY',
  license: 'CREATOR_LICENSE_KEY',
  s3AccessKeyId: 'S3_ACCESS_KEY_ID',
  s3SecretAccessKey: 'S3_SECRET_ACCESS_KEY',
  s3SessionToken: 'S3_SESSION_TOKEN',
  manifestSigningKey: 'CREATOR_MANIFEST_SIGNING_KEY',
} as const

export type SecretName = (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES]

export const ENV_ALIASES: Record<string, string[]> = {
  OPENROUTER_API_KEY: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
  MUAPI_KEY: ['MUAPI_KEY', 'MUAPI_API_KEY'],
  FAL_KEY: ['FAL_KEY', 'FAL_API_KEY'],
  ELEVENLABS_API_KEY: ['ELEVENLABS_API_KEY', 'ELEVEN_API_KEY'],
  GEMINI_API_KEY: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  POSTIZ_API_KEY: ['POSTIZ_API_KEY'],
  CREATOR_LICENSE_KEY: ['CREATOR_LICENSE_KEY', 'ARCANEA_LICENSE_KEY'],
  S3_ACCESS_KEY_ID: ['S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID'],
  S3_SECRET_ACCESS_KEY: ['S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY'],
  S3_SESSION_TOKEN: ['S3_SESSION_TOKEN', 'AWS_SESSION_TOKEN'],
  CREATOR_MANIFEST_SIGNING_KEY: ['CREATOR_MANIFEST_SIGNING_KEY'],
}
