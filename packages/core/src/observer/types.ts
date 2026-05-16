export type ParsedObserverSection = {
  id?: string;
  level: 2 | 3;
  heading: string;
  refs: string[];
  delete: boolean;
  body: string;
  children: ParsedObserverSection[];
};

export type ParsedObserverDocument = {
  title: string;
  sections: ParsedObserverSection[];
};
