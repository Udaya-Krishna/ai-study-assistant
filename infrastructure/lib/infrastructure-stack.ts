import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─────────────────────────────────────────
    // 1. S3 — PDF Storage
    // ─────────────────────────────────────────
    const pdfBucket = new s3.Bucket(this, 'PdfBucket', {
      bucketName: `ai-study-pdfs-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // ─────────────────────────────────────────
    // 2. DynamoDB — Users, Scores, History
    // ─────────────────────────────────────────
    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'ai-study-users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const scoresTable = new dynamodb.Table(this, 'ScoresTable', {
      tableName: 'ai-study-scores',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const documentsTable = new dynamodb.Table(this, 'DocumentsTable', {
      tableName: 'ai-study-documents',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─────────────────────────────────────────
    // 3. Cognito — Auth
    // ─────────────────────────────────────────
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'ai-study-user-pool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: 'ai-study-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
    });

    // ─────────────────────────────────────────
    // 4. VPC — for RDS and Lambda
    // ─────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'StudyVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Security group for Lambda
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSG', {
      vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true,
    });

    // Security group for RDS
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSG', {
      vpc,
      description: 'Security group for RDS',
    });

    // Allow Lambda to connect to RDS on port 5432
    dbSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Lambda to connect to RDS'
    );

    // ─────────────────────────────────────────
    // 5. RDS PostgreSQL — pgvector for RAG
    // ─────────────────────────────────────────
    const dbSecret = new rds.DatabaseSecret(this, 'DbSecret', {
      username: 'studyadmin',
    });

    const _database = new rds.DatabaseInstance(this, 'StudyDb', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: 'studydb',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // ─────────────────────────────────────────
    // 6. Lambda Functions
    // ─────────────────────────────────────────
    const commonEnv = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      PDF_BUCKET: pdfBucket.bucketName,
      USERS_TABLE: usersTable.tableName,
      SCORES_TABLE: scoresTable.tableName,
      DOCUMENTS_TABLE: documentsTable.tableName,
      DB_SECRET_ARN: dbSecret.secretArn,
      REGION: this.region,
    };

    const commonLambdaProps = {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'lambda_function.handler',
      environment: commonEnv,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    };

    const uploadLambda = new lambda.Function(this, 'UploadLambda', {
      ...commonLambdaProps,
      functionName: 'ai-study-upload',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/upload')),
      timeout: cdk.Duration.seconds(30),
    });

    const embedLambda = new lambda.Function(this, 'EmbedLambda', {
      ...commonLambdaProps,
      functionName: 'ai-study-embed',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/embed')),
      timeout: cdk.Duration.seconds(120),
    });

    const summaryLambda = new lambda.Function(this, 'SummaryLambda', {
      ...commonLambdaProps,
      functionName: 'ai-study-summary',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/summary')),
      timeout: cdk.Duration.seconds(60),
    });

    const quizLambda = new lambda.Function(this, 'QuizLambda', {
      ...commonLambdaProps,
      functionName: 'ai-study-quiz',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/quiz')),
      timeout: cdk.Duration.seconds(60),
    });

    const chatLambda = new lambda.Function(this, 'ChatLambda', {
      ...commonLambdaProps,
      functionName: 'ai-study-chat',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/chat')),
      timeout: cdk.Duration.seconds(60),
    });

    // ─────────────────────────────────────────
    // 7. Grant Permissions
    // ─────────────────────────────────────────
    pdfBucket.grantReadWrite(uploadLambda);
    pdfBucket.grantRead(embedLambda);
    pdfBucket.grantRead(summaryLambda);
    pdfBucket.grantRead(quizLambda);

    usersTable.grantReadWriteData(uploadLambda);
    documentsTable.grantReadWriteData(uploadLambda);
    documentsTable.grantReadData(embedLambda);
    documentsTable.grantReadData(summaryLambda);
    documentsTable.grantReadData(quizLambda);
    documentsTable.grantReadData(chatLambda);
    scoresTable.grantReadWriteData(quizLambda);
    scoresTable.grantReadData(chatLambda);

    dbSecret.grantRead(embedLambda);
    dbSecret.grantRead(chatLambda);

    // ─────────────────────────────────────────
    // 8. API Gateway
    // ─────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'StudyApi', {
      restApiName: 'ai-study-api',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [userPool],
    });

    const authOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // Routes
    api.root.addResource('upload')
      .addMethod('POST', new apigateway.LambdaIntegration(uploadLambda), authOptions);

    api.root.addResource('embed')
      .addMethod('POST', new apigateway.LambdaIntegration(embedLambda), authOptions);

    api.root.addResource('summary')
      .addMethod('POST', new apigateway.LambdaIntegration(summaryLambda), authOptions);

    api.root.addResource('quiz')
      .addMethod('POST', new apigateway.LambdaIntegration(quizLambda), authOptions);

    api.root.addResource('chat')
      .addMethod('POST', new apigateway.LambdaIntegration(chatLambda), authOptions);

    // ─────────────────────────────────────────
    // 9. Outputs
    // ─────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'PdfBucketName', {
      value: pdfBucket.bucketName,
      description: 'S3 Bucket for PDFs',
    });
  }
}