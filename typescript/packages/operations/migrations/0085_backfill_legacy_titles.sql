-- The exact production title audit found 16,323 visible fallback titles with
-- empty modern fields and 66 with unusable modern titles. All legacy strings
-- fit name_english. Keep the legacy field and site fallback until shadow
-- parity is checked after this backfill. D1 Time Travel bookmarks the write.
CREATE TABLE IF NOT EXISTS _title_fold_guard (mismatches INTEGER NOT NULL CHECK(mismatches=0));
INSERT INTO _title_fold_guard -- sarj-noqa: SARJ105 — One-time production corpus guard.
SELECT CASE WHEN
  ((SELECT count(*) FROM poem) < 1000 OR (SELECT count(*) FROM poem WHERE id IN (
  '001877c3-bf36-4fa9-b653-55c438eb13b6',
  '0092c2f8-69cc-4460-937b-febb3b1338df',
  '05aa8233-0a61-4a35-833a-a1d1c50eed48',
  '0907f937-68b2-42d9-aec0-ee4998428e98',
  '09f6f791-464a-4528-89ff-c8d603492bf4',
  '0f9d6895-e0d0-40d8-afca-8f9de8a4783a',
  '10b1ca3b-ff48-47f4-8ea5-7422aa212504',
  '18919971-acba-4934-a3bb-acdede176b3f',
  '1940c9fd-8575-441f-ad5b-26fb2f7c0a77',
  '19ff1ca9-03d3-4603-8938-93c8181e57fd',
  '22e50fac-9fcd-4096-b17a-80a534848435',
  '22ef9046-8599-47d0-a083-1efef608e017',
  '22f7d713-642b-47d1-9eb3-71577336bdbf',
  '287b2cf4-2593-4e0d-a0ee-49dd2e1a1966',
  '2ad22ad1-a101-40a1-b422-d7a2a9f222fe',
  '2af183f4-75cb-49f5-8133-4882bce97616',
  '2bab2658-4952-4043-8853-579c19d32f66',
  '2d2adf87-f418-4430-886d-e17d24845b22',
  '30b03377-8fc4-4807-9a53-50ce4a1aa6db',
  '384fd711-d11f-4fba-a267-6bc3b33db1f6',
  '39353b5d-5e3c-4341-a522-6b1f0a50211f',
  '39d06f63-1604-496b-8762-ee0587ee2c64',
  '3a8c9456-c3c1-41a9-a9f0-f0a7f8435afe',
  '3b8afb84-9e90-4060-adeb-0476dd45414d',
  '3dbc7885-1c10-4ff6-b447-d305afa74ee1',
  '3e5cf31e-0a23-4498-8500-811fdf3f03a8',
  '3fb327c6-5272-4390-884e-8a686be4097c',
  '40ed3857-6be2-42aa-873a-2a97aa97f363',
  '410bed7d-7ec1-4a2e-9c8c-51359f861077',
  '45671a23-06be-4c66-be88-7165e985e542',
  '46e5dde6-0c28-4dfc-9f62-f039efe364c4',
  '47e3a4af-fc84-44fa-96b9-9e60f0296fd4',
  '4f59968a-0612-4a57-b4bf-34f70880a8bf',
  '50cebeae-e6a8-4c55-ba5d-48482391c85a',
  '510aca0e-df0b-4b6d-bca2-6a193e84d10b',
  '542836bd-cdda-4958-b72f-e2a408d0f6c6',
  '551a2203-05ad-438b-9ff6-4429f97c34c1',
  '551de255-6004-4b51-8351-11de25336b37',
  '552c86db-fbbe-41b7-8d32-4e61819c39a4',
  '55f063f7-1718-4901-8cb9-a94d5d4d6626',
  '567c5129-2438-478b-b6ae-d37ff7c63beb',
  '5a36bffa-f516-472a-81ba-f4f1bf1aa7d5',
  '5bd05f23-6ac4-42c5-b3b1-dc43dbd82f57',
  '60b543b2-202e-4581-8276-6081cd2e6f87',
  '6428b38f-ca29-4021-b827-9477f503f938',
  '645d18e1-2864-4253-a507-4def6e3c8044',
  '664f112e-8a61-401a-93e8-950da40259ef',
  '68a0987f-daed-4f5e-9cbf-a5b287be085b',
  '6eb7c9e2-337a-4e05-8934-a36b1cb256e9',
  '6f182056-8358-4627-98d1-7797b8576b58',
  '72ce699f-b7f4-4ef8-a9ae-1c5c06992b86',
  '76973056-734c-4a07-afd4-5a845b4f0b61',
  '77db8be0-3830-4adb-b398-fd0af870e150',
  '79c641f1-33b1-4df3-b132-2617d74a5e81',
  '7bb500c4-2ac5-42a1-85ba-4cdcb68282fc',
  '7bc7e45b-a1a3-48f0-9b33-5299476d19bc',
  '7c091048-b1f7-4c96-9540-8b09005f40c0',
  '7c2c8c3c-57a2-4d6d-b14e-3b2d78a755f1',
  '7ea12bd2-b103-4e69-a198-26308137a31e',
  '7f864c62-9438-4663-bb7f-c8dee584cc39',
  '7fb0068a-3d15-49bc-92b4-d53a89297b78',
  '8b149516-4f5c-4a23-9f64-825b0d40b4b6',
  '8d054c40-b1c1-490a-80f7-5a3b0d6e921d',
  '93cdf036-cf23-40cd-8836-7639e4dfc1be',
  '9402ec04-e827-4ec2-bcb8-d7f4bd2afd6c',
  '96582f83-5ae6-47f8-a1d4-2de5ce51a459'
  ) AND poem_title_first_line IS NOT NULL) = 66)
  AND (SELECT coalesce(max(length(poem_title_first_line)), 0) FROM poem) <= 200
THEN 0 ELSE 1 END;
DROP TABLE IF EXISTS _title_fold_guard;
-- Old title triggers inspect the historical field and would reject some
-- previously visible values during the copy. The public reader's validator
-- continues to decide visibility; future writes get the narrow guard below.
DROP TRIGGER IF EXISTS poem_generated_title_guard_before_insert;
DROP TRIGGER IF EXISTS poem_generated_title_guard_before_update;
UPDATE poem SET name_english = trim(poem_title_first_line)
WHERE (name_english IS NULL OR trim(name_english) = '')
  AND poem_title_first_line IS NOT NULL;
UPDATE poem SET name_english = trim(poem_title_first_line)
WHERE id IN (
  '001877c3-bf36-4fa9-b653-55c438eb13b6',
  '0092c2f8-69cc-4460-937b-febb3b1338df',
  '05aa8233-0a61-4a35-833a-a1d1c50eed48',
  '0907f937-68b2-42d9-aec0-ee4998428e98',
  '09f6f791-464a-4528-89ff-c8d603492bf4',
  '0f9d6895-e0d0-40d8-afca-8f9de8a4783a',
  '10b1ca3b-ff48-47f4-8ea5-7422aa212504',
  '18919971-acba-4934-a3bb-acdede176b3f',
  '1940c9fd-8575-441f-ad5b-26fb2f7c0a77',
  '19ff1ca9-03d3-4603-8938-93c8181e57fd',
  '22e50fac-9fcd-4096-b17a-80a534848435',
  '22ef9046-8599-47d0-a083-1efef608e017',
  '22f7d713-642b-47d1-9eb3-71577336bdbf',
  '287b2cf4-2593-4e0d-a0ee-49dd2e1a1966',
  '2ad22ad1-a101-40a1-b422-d7a2a9f222fe',
  '2af183f4-75cb-49f5-8133-4882bce97616',
  '2bab2658-4952-4043-8853-579c19d32f66',
  '2d2adf87-f418-4430-886d-e17d24845b22',
  '30b03377-8fc4-4807-9a53-50ce4a1aa6db',
  '384fd711-d11f-4fba-a267-6bc3b33db1f6',
  '39353b5d-5e3c-4341-a522-6b1f0a50211f',
  '39d06f63-1604-496b-8762-ee0587ee2c64',
  '3a8c9456-c3c1-41a9-a9f0-f0a7f8435afe',
  '3b8afb84-9e90-4060-adeb-0476dd45414d',
  '3dbc7885-1c10-4ff6-b447-d305afa74ee1',
  '3e5cf31e-0a23-4498-8500-811fdf3f03a8',
  '3fb327c6-5272-4390-884e-8a686be4097c',
  '40ed3857-6be2-42aa-873a-2a97aa97f363',
  '410bed7d-7ec1-4a2e-9c8c-51359f861077',
  '45671a23-06be-4c66-be88-7165e985e542',
  '46e5dde6-0c28-4dfc-9f62-f039efe364c4',
  '47e3a4af-fc84-44fa-96b9-9e60f0296fd4',
  '4f59968a-0612-4a57-b4bf-34f70880a8bf',
  '50cebeae-e6a8-4c55-ba5d-48482391c85a',
  '510aca0e-df0b-4b6d-bca2-6a193e84d10b',
  '542836bd-cdda-4958-b72f-e2a408d0f6c6',
  '551a2203-05ad-438b-9ff6-4429f97c34c1',
  '551de255-6004-4b51-8351-11de25336b37',
  '552c86db-fbbe-41b7-8d32-4e61819c39a4',
  '55f063f7-1718-4901-8cb9-a94d5d4d6626',
  '567c5129-2438-478b-b6ae-d37ff7c63beb',
  '5a36bffa-f516-472a-81ba-f4f1bf1aa7d5',
  '5bd05f23-6ac4-42c5-b3b1-dc43dbd82f57',
  '60b543b2-202e-4581-8276-6081cd2e6f87',
  '6428b38f-ca29-4021-b827-9477f503f938',
  '645d18e1-2864-4253-a507-4def6e3c8044',
  '664f112e-8a61-401a-93e8-950da40259ef',
  '68a0987f-daed-4f5e-9cbf-a5b287be085b',
  '6eb7c9e2-337a-4e05-8934-a36b1cb256e9',
  '6f182056-8358-4627-98d1-7797b8576b58',
  '72ce699f-b7f4-4ef8-a9ae-1c5c06992b86',
  '76973056-734c-4a07-afd4-5a845b4f0b61',
  '77db8be0-3830-4adb-b398-fd0af870e150',
  '79c641f1-33b1-4df3-b132-2617d74a5e81',
  '7bb500c4-2ac5-42a1-85ba-4cdcb68282fc',
  '7bc7e45b-a1a3-48f0-9b33-5299476d19bc',
  '7c091048-b1f7-4c96-9540-8b09005f40c0',
  '7c2c8c3c-57a2-4d6d-b14e-3b2d78a755f1',
  '7ea12bd2-b103-4e69-a198-26308137a31e',
  '7f864c62-9438-4663-bb7f-c8dee584cc39',
  '7fb0068a-3d15-49bc-92b4-d53a89297b78',
  '8b149516-4f5c-4a23-9f64-825b0d40b4b6',
  '8d054c40-b1c1-490a-80f7-5a3b0d6e921d',
  '93cdf036-cf23-40cd-8836-7639e4dfc1be',
  '9402ec04-e827-4ec2-bcb8-d7f4bd2afd6c',
  '96582f83-5ae6-47f8-a1d4-2de5ce51a459'
);
CREATE TRIGGER poem_generated_title_guard_before_insert
BEFORE INSERT ON poem
WHEN
  (NEW.name_english IS NOT NULL AND (
    instr(NEW.name_english, char(10)) > 0
    OR length(trim(NEW.name_english)) > 200
  ))
  OR EXISTS (
    SELECT 1
    FROM json_each(json_array(
      '*here is*translat*', '*ai assistant*', '*unable to translat*',
      '*cannot translat*', '*do not*translat*', '*don''t*translat*',
      '*attempt*translat*', '*translated title*', '*from english to arabic*',
      '*you are an arabic*', 'i will not*translat*', 'i will not*provide*',
      'i have nothing*translat*', 'i have nothing*output*',
      'i have not*translat*', 'i presume not*translat*',
      'i did not*translat*', 'i am not able*translat*',
      'you''re right*translat*', '*without proper context*',
      '*copyrighted material*', '*as requested*translat*',
      '*as requested*output*', '*do not speak arabic*',
      '*not attempt to translat*', '*refrain from translat*',
      '*translation capabilities*', '*translation services*',
      '*please provide*arabic*', '*let''s have*discussion*',
      '*let''s have*conversation*', '*entrust you*translate*',
      'nice try*translate*', 'without permission*translate*',
      'translated to *', 'titles translated', 'my poem translation:'
    )) AS rejected
    WHERE lower(COALESCE(NEW.name_english, '')) GLOB rejected.value
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid generated poem title');
END;
CREATE TRIGGER poem_generated_title_guard_before_update
BEFORE UPDATE OF name_english ON poem
WHEN
  (NEW.name_english IS NOT NULL AND (
    instr(NEW.name_english, char(10)) > 0
    OR length(trim(NEW.name_english)) > 200
  ))
  OR EXISTS (
    SELECT 1
    FROM json_each(json_array(
      '*here is*translat*', '*ai assistant*', '*unable to translat*',
      '*cannot translat*', '*do not*translat*', '*don''t*translat*',
      '*attempt*translat*', '*translated title*', '*from english to arabic*',
      '*you are an arabic*', 'i will not*translat*', 'i will not*provide*',
      'i have nothing*translat*', 'i have nothing*output*',
      'i have not*translat*', 'i presume not*translat*',
      'i did not*translat*', 'i am not able*translat*',
      'you''re right*translat*', '*without proper context*',
      '*copyrighted material*', '*as requested*translat*',
      '*as requested*output*', '*do not speak arabic*',
      '*not attempt to translat*', '*refrain from translat*',
      '*translation capabilities*', '*translation services*',
      '*please provide*arabic*', '*let''s have*discussion*',
      '*let''s have*conversation*', '*entrust you*translate*',
      'nice try*translate*', 'without permission*translate*',
      'translated to *', 'titles translated', 'my poem translation:'
    )) AS rejected
    WHERE lower(COALESCE(NEW.name_english, '')) GLOB rejected.value
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid generated poem title');
END;
