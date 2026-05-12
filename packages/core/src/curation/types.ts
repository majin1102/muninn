export type CurationObservationDraft = {
  heading: string;
  text: string;
  references: string[];
};

export type ParsedCurationDocument = {
  title: string;
  content: string;
  summary: string;
  observations: CurationObservationDraft[];
};
