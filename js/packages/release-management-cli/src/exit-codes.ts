export const ExitCode = {
  Success: 0,
  UserError: 1,
  EnvironmentError: 2,
  PartialSuccess: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
