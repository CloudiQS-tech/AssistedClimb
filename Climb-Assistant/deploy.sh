#!/bin/bash
#
# Assisted CLIMB - Build, push, and deploy script
#
# Builds the backend and frontend Docker images from this repo, pushes them to
# the existing ECR repositories, registers new ECS task definition revisions,
# and rolls out the update to the live services.
#
# This script assumes the AWS infrastructure (ECS cluster, ECR repos, RDS,
# ALB, etc.) already exists - see cloudformation/deploy.sh for initial
# infrastructure provisioning. This script is for ongoing application
# deployments only.
#
# Usage:
#   ./deploy.sh                 Build, push, and deploy both services
#   ./deploy.sh backend         Build, push, and deploy backend only
#   ./deploy.sh frontend        Build, push, and deploy frontend only
#   ./deploy.sh --skip-build    Push/deploy using images already built locally
#   ./deploy.sh help            Show usage

set -e  # Exit on any error

# ---------------------------------------------------------------------------
# Configuration - matches the live AWS environment as of 2026-09-22
# ---------------------------------------------------------------------------
AWS_PROFILE="sandbox-430367037753"
REGION="eu-west-2"
ACCOUNT_ID="430367037753"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

CLUSTER="Assisted-CLIMB-cluster"

BACKEND_REPO="assisted-climb-backend"
BACKEND_SERVICE="Assisted-CLIMB-backend-svc"
BACKEND_TASK_FAMILY="Assisted-CLIMB-backend"
BACKEND_DOCKERFILE="Dockerfile.backend"

FRONTEND_REPO="assisted-climb-frontend"
FRONTEND_SERVICE="Assisted-CLIMB-frontend-svc"
FRONTEND_TASK_FAMILY="Assisted-CLIMB-frontend"
FRONTEND_DOCKERFILE="Dockerfile.frontend"

# Tag pushed images with a timestamp as well as :latest, so every deploy is
# individually addressable and rollback doesn't depend on remembering to tag
# a backup beforehand.
IMAGE_TAG="deploy-$(date +%Y%m%d-%H%M%S)"

export AWS_PROFILE

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status()  { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
check_prerequisites() {
    print_status "Checking prerequisites..."

    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Install it before running this script."
        exit 1
    fi

    if ! docker info &> /dev/null; then
        print_error "Docker daemon is not running or not accessible. Try: sudo systemctl start docker"
        exit 1
    fi

    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI is not installed."
        exit 1
    fi

    if ! aws sts get-caller-identity --region "$REGION" &> /dev/null; then
        print_error "AWS credentials not valid. Run: aws sso login --profile $AWS_PROFILE"
        exit 1
    fi

    print_success "Prerequisites check completed"
}

# ---------------------------------------------------------------------------
# Log in to ECR
# ---------------------------------------------------------------------------
ecr_login() {
    print_status "Logging in to ECR ($ECR_REGISTRY)..."
    aws ecr get-login-password --region "$REGION" \
        | docker login --username AWS --password-stdin "$ECR_REGISTRY"
    print_success "Logged in to ECR"
}

# ---------------------------------------------------------------------------
# Build and push a single image
#   $1 = repo name
#   $2 = Dockerfile path (relative to repo root)
#   $3 = human-readable label
# ---------------------------------------------------------------------------
build_and_push() {
    local repo=$1
    local dockerfile=$2
    local label=$3
    local image="${ECR_REGISTRY}/${repo}"

    print_status "Building $label image from $dockerfile..."
    docker build -f "$dockerfile" -t "${image}:${IMAGE_TAG}" -t "${image}:latest" .
    print_success "$label image built"

    print_status "Pushing $label image to ECR ($repo)..."
    docker push "${image}:${IMAGE_TAG}"
    docker push "${image}:latest"
    print_success "$label image pushed as :${IMAGE_TAG} and :latest"
}

# ---------------------------------------------------------------------------
# Register a new task definition revision from the current live one,
# updated to point at the newly pushed image. Preserves every other field
# (env vars, roles, cpu/memory, logging) exactly as-is.
#   $1 = task family name
#   $2 = new image URI
# Prints the new revision's ARN to stdout on success.
# ---------------------------------------------------------------------------
register_new_revision() {
    local family=$1
    local new_image=$2
    local tmp_current
    local tmp_new
    tmp_current=$(mktemp)
    tmp_new=$(mktemp)

    aws ecs describe-task-definition \
        --task-definition "$family" \
        --region "$REGION" \
        --query 'taskDefinition' > "$tmp_current"

    python3 - "$tmp_current" "$tmp_new" "$new_image" <<'PYEOF'
import json
import sys

src_path, dst_path, new_image = sys.argv[1], sys.argv[2], sys.argv[3]

with open(src_path) as f:
    td = json.load(f)

for key in ["taskDefinitionArn", "revision", "status", "requiresAttributes",
            "compatibilities", "registeredAt", "registeredBy"]:
    td.pop(key, None)

td["containerDefinitions"][0]["image"] = new_image

with open(dst_path, "w") as f:
    json.dump(td, f, indent=2)
PYEOF

    local new_arn
    new_arn=$(aws ecs register-task-definition \
        --cli-input-json "file://$tmp_new" \
        --region "$REGION" \
        --query 'taskDefinition.taskDefinitionArn' \
        --output text)

    rm -f "$tmp_current" "$tmp_new"
    echo "$new_arn"
}

# ---------------------------------------------------------------------------
# Roll out a new task definition revision to a service and wait for it to
# reach steady state.
#   $1 = service name
#   $2 = task definition ARN (or family:revision)
# ---------------------------------------------------------------------------
deploy_service() {
    local service=$1
    local task_def=$2

    print_status "Updating service $service to use $task_def..."
    aws ecs update-service \
        --cluster "$CLUSTER" \
        --service "$service" \
        --task-definition "$task_def" \
        --region "$REGION" \
        --query 'service.{status:status,taskDefinition:taskDefinition}' \
        --output table

    print_status "Waiting for $service to reach steady state (this can take a minute or two)..."
    aws ecs wait services-stable \
        --cluster "$CLUSTER" \
        --services "$service" \
        --region "$REGION"

    print_success "$service is stable on the new task definition"
}

# ---------------------------------------------------------------------------
# Post-deploy smoke check
# ---------------------------------------------------------------------------
smoke_check() {
    print_status "Checking https://assistedclimb.cloudiqs.com ..."
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" https://assistedclimb.cloudiqs.com || echo "000")
    if [ "$http_code" = "200" ]; then
        print_success "Site responded 200 OK"
    else
        print_warning "Site responded HTTP $http_code - check CloudWatch logs before proceeding further"
    fi
}

# ---------------------------------------------------------------------------
# Deploy one component end to end (build unless --skip-build was passed)
#   $1 = "backend" or "frontend"
# ---------------------------------------------------------------------------
deploy_component() {
    local component=$1

    if [ "$component" = "backend" ]; then
        if [ "$SKIP_BUILD" != "true" ]; then
            build_and_push "$BACKEND_REPO" "$BACKEND_DOCKERFILE" "backend"
        fi
        local image="${ECR_REGISTRY}/${BACKEND_REPO}:${IMAGE_TAG}"
        print_status "Registering new backend task definition revision..."
        local new_td
        new_td=$(register_new_revision "$BACKEND_TASK_FAMILY" "$image")
        print_success "Registered $new_td"
        deploy_service "$BACKEND_SERVICE" "$new_td"

    elif [ "$component" = "frontend" ]; then
        if [ "$SKIP_BUILD" != "true" ]; then
            build_and_push "$FRONTEND_REPO" "$FRONTEND_DOCKERFILE" "frontend"
        fi
        local image="${ECR_REGISTRY}/${FRONTEND_REPO}:${IMAGE_TAG}"
        print_status "Registering new frontend task definition revision..."
        local new_td
        new_td=$(register_new_revision "$FRONTEND_TASK_FAMILY" "$image")
        print_success "Registered $new_td"
        deploy_service "$FRONTEND_SERVICE" "$new_td"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    local target="${1:-all}"

    print_status "Assisted CLIMB deployment starting"
    print_status "Image tag for this deploy: $IMAGE_TAG"
    echo

    check_prerequisites

    if [ "$SKIP_BUILD" != "true" ]; then
        ecr_login
    fi
    echo

    case "$target" in
        backend)
            deploy_component backend
            ;;
        frontend)
            deploy_component frontend
            ;;
        all)
            deploy_component backend
            echo
            deploy_component frontend
            ;;
    esac

    echo
    smoke_check
    echo
    print_success "Deployment complete (tag: $IMAGE_TAG)"
    print_warning "Rollback: re-run 'aws ecs update-service --cluster $CLUSTER --service <service> --task-definition <previous-revision> --region $REGION'"
    print_warning "Previous backend/frontend images are also tagged :pre-security-update-2026-09-22 in ECR if a full revert is needed."
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
SKIP_BUILD="false"
TARGET="all"

for arg in "$@"; do
    case "$arg" in
        --skip-build)
            SKIP_BUILD="true"
            ;;
        backend|frontend|all)
            TARGET="$arg"
            ;;
        help|-h|--help)
            echo "Usage: $0 [backend|frontend|all] [--skip-build]"
            echo
            echo "  (no argument)   Build, push, and deploy both backend and frontend"
            echo "  backend         Build, push, and deploy backend only"
            echo "  frontend        Build, push, and deploy frontend only"
            echo "  --skip-build    Skip docker build/push, only register+deploy the :latest image already in ECR"
            echo
            echo "Requires: docker (running daemon), aws CLI, an authenticated"
            echo "SSO session for profile '$AWS_PROFILE' (run: aws sso login --profile $AWS_PROFILE)"
            exit 0
            ;;
        *)
            print_error "Unknown argument: $arg"
            exit 1
            ;;
    esac
done

main "$TARGET"
