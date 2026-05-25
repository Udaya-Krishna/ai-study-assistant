import json
import boto3
import os
import re
import psycopg2
import google.generativeai as genai
from PyPDF2 import PdfReader
from io import BytesIO

# Initialize clients
s3 = boto3.client('s3')
secrets_client = boto3.client('secretsmanager')
dynamodb = boto3.resource('dynamodb')

# Gemini setup
genai.configure(api_key=os.environ['GEMINI_API_KEY'])

BUCKET_NAME = os.environ['PDF_BUCKET']
DOCUMENTS_TABLE = os.environ['DOCUMENTS_TABLE']
DB_SECRET_ARN = os.environ['DB_SECRET_ARN']

def get_db_connection():
    """Get RDS connection using secret"""
    secret = secrets_client.get_secret_value(SecretId=DB_SECRET_ARN)
    creds = json.loads(secret['SecretString'])
    
    conn = psycopg2.connect(
        host=creds['host'],
        port=creds['port'],
        database='studydb',
        user=creds['username'],
        password=creds['password']
    )
    return conn

def setup_pgvector(conn):
    """Create pgvector extension and embeddings table if not exists"""
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                chunk_text TEXT NOT NULL,
                embedding vector(768)
            );
        """)
        conn.commit()

def extract_text_from_pdf(pdf_bytes):
    """Extract text from PDF bytes"""
    reader = PdfReader(BytesIO(pdf_bytes))
    text = ""
    for page in reader.pages:
        text += page.extract_text() + "\n"
    return text

def chunk_text(text, chunk_size=500, overlap=50):
    """Split text into overlapping chunks"""
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk = ' '.join(words[i:i + chunk_size])
        chunks.append(chunk)
        i += chunk_size - overlap
    return chunks

def get_embedding(text):
    """Get embedding from Gemini"""
    result = genai.embed_content(
        model="models/embedding-001",
        content=text,
        task_type="retrieval_document"
    )
    return result['embedding']

def handler(event, context):
    try:
        # Get parameters
        body = json.loads(event['body'])
        user_id = event['requestContext']['authorizer']['claims']['sub']
        document_id = body['documentId']
        s3_key = body['s3Key']

        # Download PDF from S3
        response = s3.get_object(Bucket=BUCKET_NAME, Key=s3_key)
        pdf_bytes = response['Body'].read()

        # Extract text
        text = extract_text_from_pdf(pdf_bytes)
        if not text.strip():
            return {
                'statusCode': 400,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'Could not extract text from PDF'})
            }

        # Chunk the text
        chunks = chunk_text(text)

        # Connect to RDS and setup pgvector
        conn = get_db_connection()
        setup_pgvector(conn)

        # Delete old embeddings for this document
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM embeddings WHERE user_id = %s AND document_id = %s",
                (user_id, document_id)
            )
            conn.commit()

        # Generate and store embeddings for each chunk
        with conn.cursor() as cur:
            for i, chunk in enumerate(chunks):
                embedding = get_embedding(chunk)
                cur.execute(
                    """INSERT INTO embeddings 
                       (user_id, document_id, chunk_index, chunk_text, embedding)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (user_id, document_id, i, chunk, embedding)
                )
            conn.commit()

        conn.close()

        # Update document status in DynamoDB
        table = dynamodb.Table(DOCUMENTS_TABLE)
        table.update_item(
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