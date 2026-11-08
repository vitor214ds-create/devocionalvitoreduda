export type Devotional = {
  id: number;
  title: string;
  theme: string;
  reference: string;
  /** Paráfrase original, inspirada no texto bíblico (não é citação literal). */
  verse: string;
  reading: string[];
  heartQuestion: string;
  talkQuestion: string;
  practice: string;
  prayer: string;
};
