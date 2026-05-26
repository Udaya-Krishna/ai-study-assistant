import json
import boto3
import os
import google.generativeai as genai
from PyPDF2 import PdfReader
from io import BytesIO

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

genai.configure(api_key=os.environ['GEMINI_API_KEY'])

BUCKET_NAME = os.environ['PDF_BUCKET']
DOCUMENTS_TABLE = os.environ['DOCUMENTS_TABLE']
EMBEDDINGS_TABLE = os.environ['EMBEDDINGS_TABLE']

def extract_text_from_pdf(pdf_bytes):
    reader = PdfReader(BytesIO(pdf_bytes))
    text = ""
    for page in reader.pages:
        text += page.extract_text() + "\n"
    return text

def chunk_text(text, chunk_size=500, overlap=50):
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk = ' '.join(words[i:i + chunk_size])
        chunks.append(chunk)
        i += chunk_size - overlap
    return chunks

def get_embedding(text):
    result = genai.embed_content(
        model="models/embedding-001",
        content=text,
        task_type="retrieval_document"
    )
    return result['embedding']

def handler(event, context):
    try:
        body = json.loads(event['body'])
        user_id = event['requestContext']['authorizer']['claims']['sub']
        document_id = body['documentId']
        s3_key = body['s3Key']

        # Download PDF from S3
        response = s3.get_object(Bucket=BUCKET_NAME, Key=s3_key)
        pdf_bytes = response['Body'].read()

        # Extract and chunk text
        text = extract_text_from_pdf(pdf_bytes)
        if not text.strip():
            return {
                'statusCode': 400,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'Could not extract text from PDF'})
            }

        chunks = chunk_text(text)

        # Store embeddings in DynamoDB
        table = dynamodb.Table(EMBEDDINGS_TABLE)

        for i, chunk in enumerate(chunks):
            embedding = get_embedding(chunk)
            table.put_item(Item={
                'documentId': document_id,
                'chunkIndex': str(i),
                'userId': user_id,
                'chunkText': chunk,
                'embedding': json.dumps(embedding)
            })

        # Update document status
        docs_table = dynamodb.Table(DOCUMENTS_TABLE)
        docs_table.update_item(
            Key={'userId': user_id, 'documentId': document_id},
            UpdateExpression='SET #s = :s, chunkCount = :c',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':s': 'embedded', ':c': len(chunks)}
        )

        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({
                'message': 'Embedding complete',
                'chunks': len(chunks)
            })
        }

    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': str(e)})
        }