import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import { saveInboxItem } from '../shared/utils';

const s3Client = new S3Client({});

// Fixed userId for email-ingested items (single user system)
const EMAIL_USER_ID = process.env.EMAIL_USER_ID || 'email-ingest';

export const handler = async (event: S3Event): Promise<void> => {
  console.log('Email ingest event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    console.log(`Processing email from s3://${bucket}/${key}`);

    try {
      // Fetch raw email from S3
      const response = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );

      const rawEmail = await response.Body?.transformToString();
      if (!rawEmail) {
        console.error('Empty email content');
        continue;
      }

      // Parse the email
      const parsed = await simpleParser(rawEmail);

      const title = parsed.subject || 'Untitled';
      const notes = parsed.text || undefined;

      console.log(`Parsed email - Subject: ${title}`);

      // Save to inbox
      const result = await saveInboxItem(EMAIL_USER_ID, title, notes);
      console.log(`Saved inbox item: ${result.id}`);
    } catch (error) {
      console.error('Error processing email:', error);
      throw error;
    }
  }
};
