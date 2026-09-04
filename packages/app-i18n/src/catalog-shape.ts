export type TranslationShape<T> = {
  readonly [Key in keyof T]: T[Key] extends string
    ? string
    : T[Key] extends ReadonlyArray<infer Item>
      ? ReadonlyArray<Item extends string ? string : TranslationShape<Item>>
      : TranslationShape<T[Key]>;
};
