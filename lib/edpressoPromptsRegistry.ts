import { registerPrompt } from './promptStore';
import * as P from './edpressoPrompts';

export const edpressoClassifyPrompt           = registerPrompt('edpresso-classify',            P.edpressoClassifyPrompt,           'edpresso');
export const edpressoCompetitorResearchPrompt = registerPrompt('edpresso-competitor-research', P.edpressoCompetitorResearchPrompt, 'edpresso');
export const edpressoLinkDiscoveryPrompt      = registerPrompt('edpresso-link-discovery',      P.edpressoLinkDiscoveryPrompt,      'edpresso');
export const edpressoOutlinePrompt            = registerPrompt('edpresso-outline',             P.edpressoOutlinePrompt,            'edpresso');
export const edpressoWriterPrompt             = registerPrompt('edpresso-writer',              P.edpressoWriterPrompt,             'edpresso');
export const edpressoReviewerPrompt           = registerPrompt('edpresso-reviewer',            P.edpressoReviewerPrompt,           'edpresso');
export const edpressoWidgetReviewPrompt       = registerPrompt('edpresso-widget-review',       P.edpressoWidgetReviewPrompt,       'edpresso');
export const edpressoSeoMetaPrompt            = registerPrompt('edpresso-seo-meta',            P.edpressoSeoMetaPrompt,            'edpresso');
