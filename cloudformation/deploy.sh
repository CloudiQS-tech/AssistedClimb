#!/bin/bash

# Assisted CLIMB AWS Infrastructure Deployment Script
# This script deploys the complete CloudFormation stack for Assisted CLIMB

set -e  # Exit on any error

# Configuration
PROJECT_NAME="Assisted-CLIMB"
REGION="eu-west-2"  # London region for UK deployment
ALERT_EMAIL="admin@assistedclimb.education"
DOMAIN_NAME="assistedclimb.com"
MONTHLY_BUDGET_LIMIT=100
AWS_PROFILE="AdministratorAccess-430367037753"

# Export AWS profile for all CLI commands
export AWS_PROFILE

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check if AWS CLI is installed
    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI is not installed. Please install it first."
        exit 1
    fi
    
    # Check if AWS credentials are configured
    if ! aws sts get-caller-identity &> /dev/null; then
        print_error "AWS credentials not configured. Run 'aws configure' first."
        exit 1
    fi
    
    # Check if jq is installed (for JSON parsing)
    if ! command -v jq &> /dev/null; then
        print_warning "jq is not installed. Installing it will improve the deployment experience."
    fi
    
    print_success "Prerequisites check completed"
}

# Function to validate CloudFormation template
validate_template() {
    local template_file=$1
    local template_name=$2
    
    print_status "Validating $template_name template..."
    
    if aws cloudformation validate-template --template-body file://$template_file --region $REGION > /dev/null; then
        print_success "$template_name template is valid"
    else
        print_error "$template_name template validation failed"
        exit 1
    fi
}

# Function to deploy a CloudFormation stack
deploy_stack() {
    local stack_name=$1
    local template_file=$2
    local parameters=$3
    local capabilities=$4
    
    print_status "Deploying stack: $stack_name"
    
    # Check if stack exists
    if aws cloudformation describe-stacks --stack-name $stack_name --region $REGION &> /dev/null; then
        print_status "Stack $stack_name exists. Updating..."
        operation="update-stack"
    else
        print_status "Creating new stack: $stack_name"
        operation="create-stack"
    fi
    
    # Build command
    cmd="aws cloudformation $operation --stack-name $stack_name --template-body file://$template_file --region $REGION"
    
    if [ ! -z "$parameters" ]; then
        cmd="$cmd --parameters $parameters"
    fi
    
    if [ ! -z "$capabilities" ]; then
        cmd="$cmd --capabilities $capabilities"
    fi
    
    # Add tags
    cmd="$cmd --tags Key=Project,Value=$PROJECT_NAME Key=ManagedBy,Value=CloudFormation Key=Environment,Value=Production"
    
    # Execute command
    eval $cmd
    
    # Wait for stack operation to complete
    if [ "$operation" = "create-stack" ]; then
        print_status "Waiting for stack creation to complete..."
        aws cloudformation wait stack-create-complete --stack-name $stack_name --region $REGION
    else
        print_status "Waiting for stack update to complete..."
        aws cloudformation wait stack-update-complete --stack-name $stack_name --region $REGION
    fi
    
    print_success "Stack $stack_name deployed successfully"
}

# Function to get stack output value
get_stack_output() {
    local stack_name=$1
    local output_key=$2
    
    aws cloudformation describe-stacks --stack-name $stack_name --region $REGION --query "Stacks[0].Outputs[?OutputKey=='$output_key'].OutputValue" --output text 2>/dev/null || echo ""
}

# Main deployment function
main() {
    print_status "Starting Assisted CLIMB AWS Infrastructure Deployment"
    print_status "Region: $REGION"
    print_status "Project: $PROJECT_NAME"
    print_status "Alert Email: $ALERT_EMAIL"
    print_status "Monthly Budget: \$${MONTHLY_BUDGET_LIMIT}"
    echo
    
    # Check prerequisites
    check_prerequisites
    
    # Validate all templates
    print_status "Validating all CloudFormation templates..."
    validate_template "01-billing-alerts.yaml" "Billing Alerts"
    validate_template "02-vpc-network.yaml" "VPC Network"
    validate_template "03-iam-roles.yaml" "IAM Roles"
    validate_template "04-rds-database.yaml" "RDS Database"
    validate_template "05-ecs-cluster.yaml" "ECS Cluster"
    validate_template "06-s3-cloudfront.yaml" "S3 CloudFront"
    validate_template "07-lambda-ai.yaml" "Lambda AI"
    print_success "All templates validated successfully"
    echo
    
    # Phase 1: Billing and Cost Monitoring (us-east-1 for billing metrics)
    print_status "=== PHASE 1: BILLING AND COST MONITORING ==="
    deploy_stack \
        "$PROJECT_NAME-Billing-Alerts" \
        "01-billing-alerts.yaml" \
        "ParameterKey=AlertEmail,ParameterValue=$ALERT_EMAIL ParameterKey=MonthlyBudgetLimit,ParameterValue=$MONTHLY_BUDGET_LIMIT ParameterKey=ProjectName,ParameterValue=$PROJECT_NAME" \
        "CAPABILITY_NAMED_IAM"
    echo
    
    # Phase 2: VPC and Network Infrastructure
    print_status "=== PHASE 2: VPC AND NETWORK INFRASTRUCTURE ==="
    deploy_stack \
        "$PROJECT_NAME-VPC-Network" \
        "02-vpc-network.yaml" \
        "ParameterKey=ProjectName,ParameterValue=$PROJECT_NAME" \
        ""
    echo
    
    # Phase 3: IAM Roles and Policies
    print_status "=== PHASE 3: IAM ROLES AND POLICIES ==="
    deploy_stack \
        "$PROJECT_NAME-IAM-Roles" \
        "03-iam-roles.yaml" \
        "ParameterKey=ProjectName,ParameterValue=$PROJECT_NAME" \
        "CAPABILITY_NAMED_IAM"
    echo
    
    # Phase 4: RDS Database
    print_status "=== PHASE 4: RDS DATABASE ==="
    deploy_stack \
        "$PROJECT_NAME-RDS-Database" \
        "04-rds-database.yaml" \
        "ParameterKey=ProjectName,ParameterValue=$PROJECT_NAME ParameterKey=DBInstanceClass,ParameterValue=db.t3.small ParameterKey=MultiAZ,ParameterValue=false" \
        ""
    echo
    
    # Phase 5: ECS Cluster and Application Load Balancer
    print_status "=== PHASE 5: ECS CLUSTER AND APPLICATION LOAD BALANCER ==="
    deploy_stack \
        "$PROJECT_NAME-ECS-Cluster" \
        "05-ecs-cluster.yaml" \
        "ParameterKey=ProjectName,ParameterValue=$PROJECT_NAME ParameterKey=DesiredCount,ParameterValue=1" \
        ""
    echo
    
    # Phase 6: S3 and CloudFront
    print_status "=== PHASE 6: S3 STORAGE AND CLOUDFRONT CDN ==="
    deploy_stack \
        "$PROJECT_NAME-S3-CloudFront" \
        "06-s3-cloudfront.yaml" \
        "ParameterKey=ProjectName,ParameterValue=$PROJECT_NAME ParameterKey=DomainName,ParameterValue=$DOMAIN_NAME ParameterKey=CreateCertificate,ParameterValue=true" \
        ""
    echo
    
    # Phase 7: Lambda AI Functions
    print_status "=== PHASE 7: LAMBDA AI FUNCTIONS ==="
    deploy_stack \
        "$PROJECT_NAME-Lambda-AI" \
        "07-lambda-ai.yaml" \
        "ParameterKey=ProjectName,ParameterValue=$PROJECT_NAME" \
        ""
    echo
    
    # Get important outputs
    print_status "=== DEPLOYMENT SUMMARY ==="
    
    ALB_DNS=$(get_stack_output "$PROJECT_NAME-ECS-Cluster" "ALBDNSName")
    CLOUDFRONT_DOMAIN=$(get_stack_output "$PROJECT_NAME-S3-CloudFront" "CloudFrontDomainName")
    APP_URL=$(get_stack_output "$PROJECT_NAME-S3-CloudFront" "AppURL")
    DB_ENDPOINT=$(get_stack_output "$PROJECT_NAME-RDS-Database" "DatabaseEndpoint")
    
    echo
    print_success "=== Assisted CLIMB AWS Infrastructure Deployed Successfully! ==="
    echo
    print_status "Important URLs and Information:"
    echo "  • Application Load Balancer: http://$ALB_DNS"
    echo "  • CloudFront Distribution: https://$CLOUDFRONT_DOMAIN"
    echo "  • Application URL: $APP_URL"
    echo "  • Database Endpoint: $DB_ENDPOINT"
    echo
    print_status "Cost Monitoring:"
    echo "  • Monthly Budget Limit: \$${MONTHLY_BUDGET_LIMIT}"
    echo "  • Billing Alerts: $ALERT_EMAIL"
    echo "  • Cost Explorer: Enabled"
    echo
    print_warning "Next Steps:"
    echo "  1. Configure AI API keys in AWS Secrets Manager"
    echo "  2. Build and push Docker images to ECR"
    echo "  3. Update ECS task definitions with actual image URIs"
    echo "  4. Set up custom domain DNS (if using custom domain)"
    echo "  5. Test the complete application workflow"
    echo
    print_status "Deployment completed at: $(date)"
    
    # Save deployment info to file
    cat > deployment-info.json << EOF
{
  "deployment_date": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "region": "$REGION",
  "project_name": "$PROJECT_NAME",
  "alert_email": "$ALERT_EMAIL",
  "monthly_budget": $MONTHLY_BUDGET_LIMIT,
  "alb_dns": "$ALB_DNS",
  "cloudfront_domain": "$CLOUDFRONT_DOMAIN",
  "app_url": "$APP_URL",
  "database_endpoint": "$DB_ENDPOINT",
  "stacks": [
    "$PROJECT_NAME-Billing-Alerts",
    "$PROJECT_NAME-VPC-Network", 
    "$PROJECT_NAME-IAM-Roles",
    "$PROJECT_NAME-RDS-Database",
    "$PROJECT_NAME-ECS-Cluster",
    "$PROJECT_NAME-S3-CloudFront",
    "$PROJECT_NAME-Lambda-AI"
  ]
}
EOF
    
    print_success "Deployment information saved to deployment-info.json"
}

# Function to cleanup/destroy all stacks (optional)
cleanup() {
    print_warning "This will DELETE ALL Assisted CLIMB infrastructure!"
    read -p "Are you sure you want to continue? (yes/no): " confirm
    
    if [ "$confirm" != "yes" ]; then
        print_status "Cleanup cancelled"
        exit 0
    fi
    
    print_status "Deleting all stacks in reverse order..."
    
    # Delete in reverse dependency order
    stacks=(
        "$PROJECT_NAME-Lambda-AI"
        "$PROJECT_NAME-S3-CloudFront"
        "$PROJECT_NAME-ECS-Cluster"
        "$PROJECT_NAME-RDS-Database"
        "$PROJECT_NAME-IAM-Roles"
        "$PROJECT_NAME-VPC-Network"
        "$PROJECT_NAME-Billing-Alerts"
    )
    
    for stack in "${stacks[@]}"; do
        if aws cloudformation describe-stacks --stack-name $stack --region $REGION &> /dev/null; then
            print_status "Deleting stack: $stack"
            aws cloudformation delete-stack --stack-name $stack --region $REGION
            aws cloudformation wait stack-delete-complete --stack-name $stack --region $REGION
            print_success "Stack $stack deleted"
        else
            print_warning "Stack $stack does not exist"
        fi
    done
    
    print_success "All stacks deleted successfully"
}

# Parse command line arguments
case "${1:-}" in
    "cleanup"|"destroy")
        cleanup
        ;;
    "help"|"-h"|"--help")
        echo "Usage: $0 [command]"
        echo
        echo "Commands:"
        echo "  (no command)  - Deploy all infrastructure"
        echo "  cleanup       - Delete all infrastructure"
        echo "  help          - Show this help message"
        echo
        echo "Configuration (edit script variables):"
        echo "  PROJECT_NAME: $PROJECT_NAME"
        echo "  REGION: $REGION" 
        echo "  ALERT_EMAIL: $ALERT_EMAIL"
        echo "  DOMAIN_NAME: $DOMAIN_NAME"
        echo "  MONTHLY_BUDGET_LIMIT: $MONTHLY_BUDGET_LIMIT"
        ;;
    "")
        main
        ;;
    *)
        print_error "Unknown command: $1"
        echo "Run '$0 help' for usage information"
        exit 1
        ;;
esac