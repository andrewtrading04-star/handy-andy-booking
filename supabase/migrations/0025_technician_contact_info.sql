-- Add contact information for technicians
-- Normalizing phone to E.164 format (+1XXXXXXXXXX for US numbers)

UPDATE app.technicians SET phone = '+13465628523', email = 'jfcobeltran82@gmail.com' WHERE name ILIKE 'juan%';
UPDATE app.technicians SET phone = '+17208792588', email = 'rockiees@aol.com' WHERE name ILIKE 'steve%';
UPDATE app.technicians SET phone = '+17203711561', email = 'heatherg17@gmail.com' WHERE name ILIKE 'heather%';
UPDATE app.technicians SET phone = '+15122845056', email = 'zzbenaya@gmail.com' WHERE name ILIKE 'zach%';
UPDATE app.technicians SET phone = '+13032173758', email = 'kreggtony@gmail.com' WHERE name ILIKE 'kregg%';
UPDATE app.technicians SET phone = '+17206568761', email = 'somethingforeverything01@gmail.com' WHERE name ILIKE 'tk%';
UPDATE app.technicians SET phone = '+13038854836', email = 'mojopac9185@gmail.com' WHERE name ILIKE 'gregory%';
