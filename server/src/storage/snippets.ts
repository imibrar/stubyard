import type { InstanceView, Snippet } from './types.js';

/** Copy-paste snippets for S3-compatible instances (AWS SDK v3, boto3, AWS CLI, Laravel, Rails, env vars). */
export function s3Snippets(v: InstanceView): Snippet[] {
  const c = v.credentials[0] ?? { accessKeyId: 'devhub', secretAccessKey: 'devhub-secret' };
  const be = v.urls.backend;
  const br = v.urls.browser;
  return [
    {
      title: 'Node.js — AWS SDK v3',
      language: 'javascript',
      code:
        `import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';\n` +
        `import { getSignedUrl } from '@aws-sdk/s3-request-presigner';\n\n` +
        `const config = {\n  region: '${v.region}',\n  forcePathStyle: true,\n  credentials: { accessKeyId: '${c.accessKeyId}', secretAccessKey: '${c.secretAccessKey}' },\n};\n` +
        `// Backend I/O (in Docker: ${v.urls.docker})\nexport const s3 = new S3Client({ ...config, endpoint: '${be}' });\n` +
        `// Presign with the browser endpoint so users can open the URLs\nconst presigner = new S3Client({ ...config, endpoint: '${br}' });\n\n` +
        `await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'hello.txt', Body: 'hi', ContentType: 'text/plain' }));\n` +
        `const url = await getSignedUrl(presigner, new GetObjectCommand({ Bucket: 'uploads', Key: 'hello.txt' }), { expiresIn: 900 });`,
    },
    {
      title: 'Python — boto3',
      language: 'python',
      code:
        `import boto3\nfrom botocore.config import Config\n\n` +
        `s3 = boto3.client(\n    "s3",\n    endpoint_url="${be}",\n    region_name="${v.region}",\n    aws_access_key_id="${c.accessKeyId}",\n    aws_secret_access_key="${c.secretAccessKey}",\n    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),\n)\n` +
        `s3.upload_file("photo.jpg", "uploads", "photos/photo.jpg")\n` +
        `url = s3.generate_presigned_url("get_object", Params={"Bucket": "uploads", "Key": "photos/photo.jpg"}, ExpiresIn=900)`,
    },
    {
      title: 'Environment (.env)',
      language: 'shell',
      code: `AWS_ENDPOINT_URL_S3=${be}\nAWS_REGION=${v.region}\nAWS_ACCESS_KEY_ID=${c.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${c.secretAccessKey}\n# Laravel\nAWS_ENDPOINT=${be}\nAWS_USE_PATH_STYLE_ENDPOINT=true\nAWS_URL=${br}`,
    },
    {
      title: 'AWS CLI',
      language: 'shell',
      code: `export AWS_ACCESS_KEY_ID=${c.accessKeyId} AWS_SECRET_ACCESS_KEY=${c.secretAccessKey} AWS_REGION=${v.region}\naws --endpoint-url ${be} s3 mb s3://uploads\naws --endpoint-url ${be} s3 cp ./photo.jpg s3://uploads/photos/\naws --endpoint-url ${be} s3 ls s3://uploads --recursive`,
    },
    {
      title: 'Rails — config/storage.yml',
      language: 'yaml',
      code: `devhub:\n  service: S3\n  endpoint: ${be}\n  force_path_style: true\n  region: ${v.region}\n  bucket: uploads\n  access_key_id: ${c.accessKeyId}\n  secret_access_key: ${c.secretAccessKey}`,
    },
  ];
}
