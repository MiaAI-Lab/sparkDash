export interface ApplicationTextDescriptor {
  key: string;
  params?: Record<string, string | number>;
}
export const APPLICATION_TEXT_MAX_LENGTH: number;
export function applicationTextI18n(raw: unknown): ApplicationTextDescriptor | undefined;
