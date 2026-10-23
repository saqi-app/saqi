-- Read only public route ownership for one known, retained production canary.
-- The expected destination never comes from the HTTP redirect being checked.
SELECT p.id AS poemId, a.slug AS legacyAuthorSlug,
  n.canonical_slug AS authorSlug, p.public_slug AS poemSlug,
  p.public_slug_language AS poemLanguage,
  EXISTS(SELECT 1 FROM public_author_segment s
    WHERE s.segment='poet-abn-rumi' AND s.namespace_id=n.id) AS legacyAuthorOwned,
  EXISTS(SELECT 1 FROM public_poem_alias s
    WHERE s.author_namespace_id=n.id AND s.segment=p.id AND s.poem_id=p.id) AS legacyPoemOwned,
  EXISTS(SELECT 1 FROM public_author_segment s
    WHERE s.segment=n.canonical_slug AND s.namespace_id=n.id) AS canonicalAuthorOwned,
  EXISTS(SELECT 1 FROM public_poem_alias s
    WHERE s.author_namespace_id=n.id AND s.segment=p.public_slug AND s.poem_id=p.id) AS canonicalPoemOwned
FROM poem p JOIN author a ON a.id=p.author_id
LEFT JOIN public_author_namespace n ON n.author_id=a.id
-- Retained rows satisfy corpus constraints; legacy visibility columns are gone.
WHERE p.id='5cf197dd-692d-4024-acc5-ee081560263f';
