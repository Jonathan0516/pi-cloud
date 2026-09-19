output "public_ip" {
  value = aws_instance.host.public_ip
}

output "instance_id" {
  value = aws_instance.host.id
}

output "ssh" {
  value = "ssh ubuntu@${aws_instance.host.public_ip}"
}

output "gateway_url" {
  value = "http://${aws_instance.host.public_ip}:${var.gateway_port}"
}

output "deploy" {
  value = "deploy/scripts/deploy.sh ubuntu@${aws_instance.host.public_ip}"
}
