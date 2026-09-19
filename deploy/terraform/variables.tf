variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  type    = string
  default = "pi-cloud"
}

variable "instance_type" {
  type        = string
  description = "c7i.4xlarge is the design's Phase 1 size; anything Nitro-based works."
  default     = "c7i.4xlarge"
}

variable "key_name" {
  type        = string
  description = "Existing EC2 key pair for SSH (SSM works without it)."
  default     = null
}

variable "admin_cidr" {
  type        = string
  description = "CIDR allowed to SSH, e.g. your office IP as x.x.x.x/32."
}

variable "client_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to reach the gateway port."
  default     = []
}

variable "gateway_port" {
  type    = number
  default = 7400
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/20"
}

variable "root_volume_gb" {
  type    = number
  default = 40
}

variable "data_volume_gb" {
  type    = number
  default = 200
}

variable "tags" {
  type    = map(string)
  default = {}
}
