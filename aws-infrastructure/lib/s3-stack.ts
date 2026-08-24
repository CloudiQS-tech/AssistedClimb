import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface S3StackProps extends cdk.StackProps {
  /**
   * Project name for resource naming
   * @default 'assisted-climb'
   */
  projectName?: string;
  
  /**
   * Domain name for CloudFront distribution
   * @default 'assistedclimb.education'
   */
  domainName?: string;
  
  /**
   * Load balancer DNS name for origin
   */
  loadBalancerDnsName: string;
  
  /**
   * SSL certificate ARN for CloudFront
   */
  certificateArn: string;
}

export class S3Stack extends cdk.Stack {
  public readonly staticAssetsBucket: s3.Bucket;
  public readonly backupsBucket: s3.Bucket;
  public readonly cloudfrontDistribution: cloudfront.Distribution;
  public readonly originAccessIdentity: cloudfront.OriginAccessIdentity;

  constructor(scope: Construct, id: string, props: S3StackProps) {
    super(scope, id, props);

    const {
      projectName = 'assisted-climb',
      domainName = 'assistedclimb.education',
      loadBalancerDnsName,
      certificateArn
    } = props;

    // Create S3 bucket for static assets
    this.staticAssetsBucket = this.createStaticAssetsBucket(projectName);
    
    // Create S3 bucket for backups
    this.backupsBucket = this.createBackupsBucket(projectName);
    
    // Create CloudFront Origin Access Identity
    this.originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'OriginAccessIdentity', {
      comment: `OAI for ${projectName} static assets`
    });
    
    // Grant CloudFront access to static assets bucket
    this.staticAssetsBucket.grantRead(this.originAccessIdentity);
    
    // Create CloudFront distribution
    this.cloudfrontDistribution = this.createCloudfrontDistribution(
      projectName,
      domainName,
      loadBalancerDnsName,
      certificateArn
    );
    
    // Deploy initial static assets
    this.deployInitialAssets(projectName);
    
    // Create outputs
    this.createOutputs();
  }

  private createStaticAssetsBucket(projectName: string): s3.Bucket {
    const bucket = new s3.Bucket(this, 'StaticAssetsBucket', {
      bucketName: `${projectName}-static-assets-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Retain for production data
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30)
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90)
            }
          ]
        }
      ],
      intelligentTieringConfigurations: [
        {
          id: 'AssetsTiering',
          prefix: 'assets/',
          archiveAccessTierTime: cdk.Duration.days(90),
          deepArchiveAccessTierTime: cdk.Duration.days(180)
        }
      ]
    });

    // Enable server access logging for security
    const accessLogsBucket = new s3.Bucket(this, 'StaticAssetsAccessLogsBucket', {
      bucketName: `${projectName}-static-assets-logs-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteAccessLogs',
          enabled: true,
          expiration: cdk.Duration.days(90)
        }
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudFrontAccess',
      effect: iam.Effect.ALLOW,
      principals: [new iam.CanonicalUserPrincipal(this.originAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId)],
      actions: ['s3:GetObject'],
      resources: [`${bucket.bucketArn}/*`]
    }));

    // Add CORS configuration for web access
    bucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
      allowedOrigins: [`https://*.${domainName}`, `https://${domainName}`],
      allowedHeaders: ['*'],
      maxAge: 3000
    });

    return bucket;
  }

  private createBackupsBucket(projectName: string): s3.Bucket {
    const bucket = new s3.Bucket(this, 'BackupsBucket', {
      bucketName: `${projectName}-backups-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Critical for backup retention
      lifecycleRules: [
        {
          id: 'BackupRetention',
          enabled: true,
          expiration: cdk.Duration.days(365), // Keep backups for 1 year
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30)
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90)
            },
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(180)
            }
          ]
        },
        {
          id: 'DeleteOldBackupVersions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(90)
        }
      ],
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED
    });

    // Enable MFA delete for production (can only be enabled via CLI/API)
    new cdk.CfnOutput(this, 'BackupsBucketMfaDeleteCommand', {
      value: `aws s3api put-bucket-versioning --bucket ${bucket.bucketName} --versioning-configuration Status=Enabled,MFADelete=Enabled --mfa "arn:aws:iam::${this.account}:mfa/root-account-mfa-device XXXXXX"`,
      description: 'Command to enable MFA delete on backups bucket (replace XXXXXX with MFA token)'
    });

    return bucket;
  }

  private createCloudfrontDistribution(
    projectName: string,
    domainName: string,
    loadBalancerDnsName: string,
    certificateArn: string
  ): cloudfront.Distribution {
    
    // Import SSL certificate
    const certificate = certificatemanager.Certificate.fromCertificateArn(this, 'ImportedCertificate', certificateArn);
    
    return new cloudfront.Distribution(this, 'CloudfrontDistribution', {
      comment: `CDN for ${projectName} - Global content delivery`,
      defaultRootObject: 'index.html',
      
      // SSL configuration
      certificate,
      domainNames: [`app.${domainName}`, `cdn.${domainName}`],
      
      // Price class for cost optimization (US, Canada, Europe)
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      
      // Origins configuration
      defaultBehavior: {
        // Load balancer as default origin for dynamic content
        origin: new origins.HttpOrigin(loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          customHeaders: {
            'X-Forwarded-Proto': 'https'
          }
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // No caching for dynamic content
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        compress: true
      },
      
      additionalBehaviors: {
        // Static assets from S3
        '/assets/*': {
          origin: new origins.S3Origin(this.staticAssetsBucket, {
            originAccessIdentity: this.originAccessIdentity
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true
        },
        
        // Images with long cache
        '/images/*': {
          origin: new origins.S3Origin(this.staticAssetsBucket, {
            originAccessIdentity: this.originAccessIdentity
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: new cloudfront.CachePolicy(this, 'ImagesCachePolicy', {
            cachePolicyName: `${projectName}-images-cache-policy`,
            defaultTtl: cdk.Duration.days(30),
            maxTtl: cdk.Duration.days(365),
            minTtl: cdk.Duration.days(1),
            headerBehavior: cloudfront.CacheHeaderBehavior.allowList('CloudFront-Viewer-Country'),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none()
          }),
          compress: true
        },
        
        // API requests - no caching
        '/api/*': {
          origin: new origins.HttpOrigin(loadBalancerDnsName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: true
        }
      },
      
      // Error page handling for SPA
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5)
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5)
        }
      ],
      
      // Geographic restrictions (none for educational platform)
      geoRestriction: cloudfront.GeoRestriction.allowlist(),
      
      // Security headers
      responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
        responseHeadersPolicyName: `${projectName}-security-headers`,
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
          referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
          strictTransportSecurity: { 
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            override: true
          },
          contentSecurityPolicy: {
            contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.assistedclimb.education",
            override: true
          }
        },
        customHeadersBehavior: {
          customHeaders: [
            { header: 'X-Content-Type-Options', value: 'nosniff', override: true },
            { header: 'X-XSS-Protection', value: '1; mode=block', override: true }
          ]
        }
      }),
      
      // Enable logging
      enableLogging: true,
      logBucket: new s3.Bucket(this, 'CloudfrontLogsBucket', {
        bucketName: `${projectName}-cloudfront-logs-${this.account}-${this.region}`,
        encryption: s3.BucketEncryption.S3_MANAGED,
        lifecycleRules: [
          {
            id: 'DeleteLogs',
            enabled: true,
            expiration: cdk.Duration.days(90)
          }
        ],
        removalPolicy: cdk.RemovalPolicy.DESTROY
      }),
      logFilePrefix: 'cloudfront-logs/',
      logIncludesCookies: false
    });
  }

  private deployInitialAssets(projectName: string): void {
    // Deploy Orby character assets and other static files
    // This is a placeholder - actual assets would be deployed via CI/CD pipeline
    new s3deploy.BucketDeployment(this, 'StaticAssetsDeployment', {
      sources: [
        // Placeholder for static assets - would be replaced with actual asset source
        s3deploy.Source.data('robots.txt', 'User-agent: *\nAllow: /'),
        s3deploy.Source.data('favicon.ico', ''), // Placeholder - would use actual favicon
        s3deploy.Source.jsonData('health.json', {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: '1.0.0'
        })
      ],
      destinationBucket: this.staticAssetsBucket,
      destinationKeyPrefix: 'assets/',
      distribution: this.cloudfrontDistribution,
      distributionPaths: ['/assets/*']
    });
  }

  private createOutputs(): void {
    // S3 bucket outputs
    new cdk.CfnOutput(this, 'StaticAssetsBucketName', {
      value: this.staticAssetsBucket.bucketName,
      description: 'Name of the S3 bucket for static assets',
      exportName: 'AssistedClimbStaticAssetsBucketName'
    });

    new cdk.CfnOutput(this, 'StaticAssetsBucketArn', {
      value: this.staticAssetsBucket.bucketArn,
      description: 'ARN of the S3 bucket for static assets',
      exportName: 'AssistedClimbStaticAssetsBucketArn'
    });

    new cdk.CfnOutput(this, 'BackupsBucketName', {
      value: this.backupsBucket.bucketName,
      description: 'Name of the S3 bucket for backups',
      exportName: 'AssistedClimbBackupsBucketName'
    });

    new cdk.CfnOutput(this, 'BackupsBucketArn', {
      value: this.backupsBucket.bucketArn,
      description: 'ARN of the S3 bucket for backups',
      exportName: 'AssistedClimbBackupsBucketArn'
    });

    // CloudFront outputs
    new cdk.CfnOutput(this, 'CloudfrontDistributionId', {
      value: this.cloudfrontDistribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: 'AssistedClimbCloudfrontDistributionId'
    });

    new cdk.CfnOutput(this, 'CloudfrontDistributionDomainName', {
      value: this.cloudfrontDistribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
      exportName: 'AssistedClimbCloudfrontDistributionDomainName'
    });

    new cdk.CfnOutput(this, 'CdnUrl', {
      value: `https://${this.cloudfrontDistribution.distributionDomainName}`,
      description: 'CDN URL for static assets',
      exportName: 'AssistedClimbCdnUrl'
    });

    // Asset upload commands
    new cdk.CfnOutput(this, 'UploadAssetsCommand', {
      value: `aws s3 sync ./static-assets s3://${this.staticAssetsBucket.bucketName}/assets/ --delete`,
      description: 'Command to upload static assets to S3'
    });

    new cdk.CfnOutput(this, 'InvalidateCacheCommand', {
      value: `aws cloudfront create-invalidation --distribution-id ${this.cloudfrontDistribution.distributionId} --paths "/*"`,
      description: 'Command to invalidate CloudFront cache'
    });
  }
}