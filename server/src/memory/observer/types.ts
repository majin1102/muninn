export type ParsedObserverSection = {
  level: 2 | 3 | 4;
  heading: string;
  globalPath: string;
  sourceRefs: string[];
  expandRefs: string[];
  body: string;
  rewritten: boolean;
  children: ParsedObserverSection[];
};

export type ParsedObserverDocument = {
  title: string;
  sections: ParsedObserverSection[];
};
