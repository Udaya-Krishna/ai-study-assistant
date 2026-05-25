import json
import boto3
import base64
import uuid
import os
from datetime import datetime

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

BUCKET_NAME = os.environ['PDF_BUCKET']
DOCUMENTS_TABLE = os.environ['DOCUMENTS_TABLE']

def handler(event, context):
    try:
        # Get user ID from Cognito token
        user_id = event['requestContext']['authorizer']['claims']['sub']

        # Parse the request body
        body = json.loads(event['body'])
        file_content = base64.b64decode(body['file'])
        file_name = body['fileName']

        # Generate unique document ID
        document_id = str(uuid.uuid4())
        s3_key = f"{user_id}/{document_id}/{file_name}"

        # Upload to S3
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=file_content,
            ContentType='application/pdf'
        )

        # Save metadata to DynamoDB
        table = dynamodb.Table(DOCUMENTS_TABLE)
        table.put_item(Item={
            'userId': user_id,
            'documentId': document_id,
            'fileName': file_name,
            's3Key': s3_key,
            'uploadedAt': datetime.utcnow().isoformat(),
            'status': 'uploaded'
        })

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'message': 'File uploaded successfully',
                'documentId': document_id,
                'fileName': file_name
            })
        }

    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'error': str(e)
            })
        }