-- Reference data only. NO legal texts, NO fabricated statutes.
insert into public.specializations (slug, name_ar, name_en, sort_order) values
 ('civil','القانون المدني','Civil law',1),
 ('criminal','القانون الجنائي','Criminal law',2),
 ('personal-status','الأحوال الشخصية','Personal status',3),
 ('commercial','القانون التجاري والشركات','Commercial & corporate',4),
 ('labor','قانون العمل','Labor law',5),
 ('administrative','القانون الإداري','Administrative law',6),
 ('real-estate','العقارات','Real estate',7),
 ('tax','الضرائب والجمارك','Tax & customs',8),
 ('ip','الملكية الفكرية','Intellectual property',9),
 ('banking','البنوك والتمويل','Banking & finance',10)
on conflict (slug) do nothing;

insert into public.consultation_categories (slug, name_ar, name_en, specialization_id, sort_order)
select s.slug, s.name_ar, s.name_en, s.id, s.sort_order from public.specializations s
on conflict (slug) do nothing;
insert into public.consultation_categories (slug, name_ar, name_en, sort_order) values
 ('other','أخرى','Other',99) on conflict (slug) do nothing;

insert into public.library_categories (slug, name_ar, name_en, sort_order) values
 ('constitution','الدستور','Constitution',1),
 ('civil-commercial','القانون المدني والتجاري','Civil & commercial',2),
 ('criminal','القانون الجنائي','Criminal',3),
 ('procedure','المرافعات والإجراءات','Procedure',4),
 ('evidence','الإثبات','Evidence',5),
 ('labor','العمل','Labor',6),
 ('personal-status','الأحوال الشخصية','Personal status',7),
 ('administrative','الإداري','Administrative',8),
 ('regulations','اللوائح التنفيذية','Executive regulations',9),
 ('judicial','المبادئ والأحكام','Judicial principles',10),
 ('bar','نقابة المحامين','Bar Association',11),
 ('forms','نماذج وعقود','Forms & contracts',12)
on conflict (slug) do nothing;
