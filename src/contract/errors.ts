export class WingmanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WingmanError';
  }
}

export class StaleElementError extends WingmanError {
  constructor(message: string) {
    super('stale-element', message);
    this.name = 'StaleElementError';
  }
}

export class CoveredTargetError extends WingmanError {
  constructor(message: string) {
    super('covered-target', message);
    this.name = 'CoveredTargetError';
  }
}

export class ActFailedError extends WingmanError {
  constructor(message: string) {
    super('act-failed', message);
    this.name = 'ActFailedError';
  }
}

export class AttachError extends WingmanError {
  constructor(message: string) {
    super('no-browser', message);
    this.name = 'AttachError';
  }
}

export class DialogOpenError extends WingmanError {
  constructor(message: string) {
    super('dialog-open', message);
    this.name = 'DialogOpenError';
  }
}

export class ConfigError extends WingmanError {
  constructor(message: string) {
    super('config', message);
    this.name = 'ConfigError';
  }
}
